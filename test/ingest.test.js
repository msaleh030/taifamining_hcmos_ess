'use strict';
// Opening-Balance & Document Ingestion — INTEGRATION tests through the real HTTP
// endpoints. Same discipline as the Exact publish: dry-run preview, maker-checker
// commit, control-totals hard-block, atomic. OB-1..OB-7 + the ingest.roles guard
// + a permits mirror.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const leave = require('../src/leave');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;
const post = (token, path, body) => H.req('POST', path, { token, body });
const get = (token, path) => H.req('GET', path, { token });

const OBP = '/ingest/opening-balance/preview';
const OBC = '/ingest/opening-balance/commit';

// Test PFs are pure digits high enough to never collide with seeded legacy_ids
// (main = 'E-A-000X', bulk = 'E000NN').
const empByPf = async (pf) => (await owner(`SELECT id, site_id FROM employee WHERE legacy_id=$1`, [pf])).rows[0];
async function purge(pfs, batchIds = []) {
  for (const pf of pfs) {
    const e = await empByPf(pf);
    if (e) {
      await owner(`DELETE FROM leave_carry_sweep WHERE employee_id=$1`, [e.id]);
      await owner(`DELETE FROM leave_carry WHERE employee_id=$1`, [e.id]);
      await owner(`DELETE FROM employee_document WHERE employee_id=$1`, [e.id]);
      await owner(`DELETE FROM employee WHERE id=$1`, [e.id]);
    }
  }
  for (const b of batchIds) await owner(`DELETE FROM ingest_batch WHERE id=$1`, [b]);
}

before(H.start);
after(H.stop);

// ── Guard (v1.5 LI-6): ingest belongs to FINANCE — Finance Manager + CFC only ─
test('ingest is guarded to the finance set (ingest.roles); HR, admin and exec are refused', async () => {
  const body = { rows: [] };
  assert.equal((await post(await tok(F.USERS.HR_A), OBP, body)).status, 403, 'R03 (HR Officer) refused');
  assert.equal((await post(await tok(F.USERS.EMP_A), OBP, body)).status, 403, 'R01 refused');
  assert.equal((await post(await tok(F.USERS.DIRECTOR_A), OBP, body)).status, 403, 'R11 refused (v1.5: ingest moved to finance)');
  assert.equal((await post(await tok(F.USERS.ADMIN_A), OBP, body)).status, 403, 'R12 admin refused (v1.5)');
  assert.equal((await post(await tok(F.USERS.FINMGR_A), OBP, body)).status, 200, 'R15 Finance Manager allowed');
  assert.equal((await post(await tok(F.USERS.CFC_A), OBP, body)).status, 200, 'R16 CFC allowed (preview is open to both legs)');
});

// ── OB-1: preview returns clean/exception split + control totals, writes nothing ─
test('OB-1 preview splits clean/exception, reports control totals, and writes NOTHING', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const before = Number((await owner(`SELECT count(*)::int n FROM ingest_batch`)).rows[0].n);
  const rows = [
    { pf: '90000001', name: 'Op One', site: 'North Mara', accrued: 20, taken: 5, balance: 15 }, // clean
    { pf: '90000002', name: 'Op Two', site: 'North Mara', accrued: 10, taken: 2, balance: 8 },  // clean
    { pf: '90000003', name: 'Bad Site', site: 'Nowhere', accrued: 5, taken: 0, balance: 5 },     // unknown site
    { pf: 'abc', name: 'Bad PF', site: 'Mwadui', accrued: 5, taken: 0, balance: 5 },             // PF not numeric
    { pf: '90000004', name: 'Mismatch', site: 'Mwadui', accrued: 10, taken: 2, balance: 5 },     // 5 != 10-2
  ];
  const control_totals = [{ site: 'North Mara', count: 2, sum_balance: 23 }];
  const r = await post(maker, OBP, { rows, control_totals });
  assert.equal(r.status, 200);
  assert.equal(r.body.clean_count, 2);
  assert.equal(r.body.exception_count, 3);
  assert.equal(r.body.control.ok, true, 'supplied totals reconcile with the clean set');
  assert.ok(r.body.exceptions.some((e) => e.exceptions.join().includes('unknown site')));
  assert.ok(r.body.exceptions.some((e) => e.exceptions.join().includes('PF not numeric')));
  assert.ok(r.body.exceptions.some((e) => e.exceptions.join().includes('accrued - taken')));

  assert.equal(Number((await owner(`SELECT count(*)::int n FROM ingest_batch`)).rows[0].n), before, 'preview staged no batch');
  assert.equal(await empByPf('90000001'), undefined, 'preview created no employee');
});

// ── OB-2 (v1.5 LI-6): Finance Manager submits, CFC approves — SoD on disjoint
// roles PLUS the same-user rule. Same person for both legs → 403 either way. ──
test('OB-2 Finance Manager submits, CFC approves → committed; same person / wrong leg → 403', async () => {
  const maker = await tok(F.USERS.FINMGR_A); // R15 Finance Manager (maker)
  const checker = await tok(F.USERS.CFC_A);  // R16 CFC (checker, distinct user)
  const rows = [
    { pf: '90010001', name: 'MC One', site: 'North Mara', accrued: 12, taken: 2, balance: 10 },
    { pf: '90010002', name: 'MC Two', site: 'North Mara', accrued: 6, taken: 1, balance: 5 },
  ];
  const control_totals = [{ site: 'North Mara', count: 2, sum_balance: 15 }];

  // Role-split (SoD by construction): the CFC cannot SUBMIT (not a maker).
  assert.equal((await post(checker, OBC, { rows, control_totals })).status, 403, 'CFC cannot act as the maker');

  const sub = await post(maker, OBC, { rows, control_totals }); // SUBMIT (maker)
  assert.equal(sub.body.status, 'submitted');
  const batchId = sub.body.batch_id;
  try {
    // Same person for both legs → 403 (the Finance Manager is not a checker; the
    // same-user rule additionally backstops any future set overlap).
    assert.equal((await post(maker, OBC, { batch_id: batchId })).status, 403, 'submitter cannot approve their own batch');
    // distinct-user, checker-role approve → committed
    const appr = await post(checker, OBC, { batch_id: batchId });
    assert.equal(appr.status, 200);
    assert.equal(appr.body.status, 'committed');
    assert.equal(appr.body.loaded, 2);
    // rows really loaded into the opening bucket
    const e = await empByPf('90010001');
    assert.ok(e, 'employee created via the creation path');
    const lc = (await owner(`SELECT days, opening_bucket FROM leave_carry WHERE employee_id=$1`, [e.id])).rows[0];
    assert.equal(Number(lc.days), 10);
    assert.equal(lc.opening_bucket, true, 'lands in the protected opening bucket');
  } finally {
    await purge(['90010001', '90010002'], [batchId]);
  }
});

// ── OB-3: control-total mismatch HARD-BLOCKS commit (409), nothing written ────
test('OB-3 a control-total mismatch blocks commit (409) and writes nothing', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  const rows = [{ pf: '90020001', name: 'CT One', site: 'North Mara', accrued: 10, taken: 0, balance: 10 }];
  // Declared sum (999) does not match the clean set (10).
  const sub = await post(maker, OBC, { rows, control_totals: [{ site: 'North Mara', count: 1, sum_balance: 999 }] });
  const batchId = sub.body.batch_id;
  try {
    const appr = await post(checker, OBC, { batch_id: batchId });
    assert.equal(appr.status, 409, 'commit blocked on control-total mismatch');
    assert.ok(appr.body.mismatches.some((m) => m.field === 'sum_balance'));
    assert.equal(await empByPf('90020001'), undefined, 'nothing written');
    assert.equal((await owner(`SELECT status FROM ingest_batch WHERE id=$1`, [batchId])).rows[0].status, 'submitted', 'batch not committed');
  } finally {
    await purge(['90020001'], [batchId]);
  }
});

// ── OB-4: atomic — an injected mid-batch fault rolls the whole batch back ─────
test('OB-4 an injected mid-batch fault rolls back the whole load; a clean run commits', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  const rows = [
    { pf: '90030001', name: 'Atom One', site: 'North Mara', accrued: 8, taken: 0, balance: 8 },
    { pf: '90030002', name: 'Atom Two', site: 'North Mara', accrued: 4, taken: 0, balance: 4 },
  ];
  const control_totals = [{ site: 'North Mara', count: 2, sum_balance: 12 }];
  const sub = await post(maker, OBC, { rows, control_totals });
  const batchId = sub.body.batch_id;
  try {
    const faulted = await post(checker, OBC, { batch_id: batchId, faultStep: 'mid_batch' });
    assert.notEqual(faulted.status, 200, 'faulted commit did not succeed');
    assert.equal(await empByPf('90030001'), undefined, 'row 1 rolled back too — nothing half-loaded');
    assert.equal(await empByPf('90030002'), undefined);

    const ok = await post(checker, OBC, { batch_id: batchId });
    assert.equal(ok.body.status, 'committed');
    assert.equal(ok.body.loaded, 2);
    assert.ok(await empByPf('90030001'));
  } finally {
    await purge(['90030001', '90030002'], [batchId]);
  }
});

// ── OB-5: opening-bucket rows are exempt from the v1.5 carry sweep ───────────
test('OB-5 opening-bucket carry is exempt from the carry sweep; normal carry on the same employee is forfeited', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  // Opening balance of 9 days for a loaded employee.
  const rows = [{ pf: '90040001', name: 'Sweep Exempt', site: 'North Mara', accrued: 9, taken: 0, balance: 9 }];
  const sub = await post(maker, OBC, { rows, control_totals: [{ site: 'North Mara', count: 1, sum_balance: 9 }] });
  const batchId = sub.body.batch_id;
  await post(checker, OBC, { batch_id: batchId });
  const e = await empByPf('90040001');
  // Give the employee an employment date + a NORMAL carry row, so the sweep
  // processes them: past anniversary+grace the normal carry is fully forfeited
  // (nothing used) while the opening bucket must remain untouched.
  await owner(`UPDATE employee SET joined_at='2020-01-15' WHERE id=$1`, [e.id]);
  const normalCarry = (await owner(
    `INSERT INTO leave_carry(company_id,employee_id,days,carried_for_year,opening_bucket)
     VALUES ($1,$2,3,2025,false) RETURNING id`, [A, e.id])).rows[0].id;
  try {
    await leave.carrySweep(A, '2026-07-01'); // anniversary 2026-01-15; grace end 2026-04-15 → both phases run
    const opening = (await owner(
      `SELECT days, lapsed_at FROM leave_carry WHERE employee_id=$1 AND opening_bucket=true`, [e.id])).rows[0];
    assert.equal(Number(opening.days), 9, 'opening-bucket days untouched');
    assert.equal(opening.lapsed_at, null, 'opening-bucket row NOT forfeited by either phase');
    const normal = (await owner(`SELECT lapsed_at FROM leave_carry WHERE id=$1`, [normalCarry])).rows[0];
    assert.notEqual(normal.lapsed_at, null, 'the normal carry on the SAME employee was forfeited (control)');
  } finally {
    await purge(['90040001'], [batchId]);
  }
});

// ── OB-6: provisioning goes through the creation path (scoped directory shows them) ─
test('OB-6 loaded employees are created via the app path and visible to a site-scoped HR user', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  const rows = [{ pf: '90050001', name: 'Zzdirectory Loadtest', site: 'North Mara', accrued: 7, taken: 0, balance: 7 }];
  const sub = await post(maker, OBC, { rows, control_totals: [{ site: 'North Mara', count: 1, sum_balance: 7 }] });
  const batchId = sub.body.batch_id;
  try {
    await post(checker, OBC, { batch_id: batchId });
    const e = await empByPf('90050001');
    assert.equal(e.site_id, F.SITE.A1, 'employee scoped to North Mara (A1)');
    // HR_A (R03) is site-bound and sits at A1 — the directory must show the load.
    const dir = await get(await tok(F.USERS.HR_A), '/employees?q=Zzdirectory');
    assert.equal(dir.status, 200);
    assert.ok(dir.body.rows.some((r) => r.id === e.id), 'a correctly-scoped HR user sees the loaded employee');
  } finally {
    await purge(['90050001'], [batchId]);
  }
});

// ── OB-7: the exception report is downloadable and complete ──────────────────
test('OB-7 the exception report lists every blocking row with its reasons', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const rows = [
    { pf: '90060001', name: 'Good', site: 'North Mara', accrued: 5, taken: 0, balance: 5 },  // clean (+5)
    { pf: 'xx', name: 'Bad PF', site: 'North Mara', accrued: 5, taken: 0, balance: 5 },       // exception (PF)
    { pf: '90060003', name: 'Mismatch', site: 'North Mara', accrued: 5, taken: 0, balance: 3 }, // exception (balance != accrued-taken)
    { pf: '90060002', name: 'Neg', site: 'North Mara', accrued: 0, taken: 5, balance: -5 },    // CLEAN now (deficit warning) — Omid ruling; -5 == 0-5
  ];
  // Clean rows Good(+5) + Neg(-5) = 0.
  const sub = await post(maker, OBC, { rows, control_totals: [{ site: 'North Mara', count: 2, sum_balance: 0 }] });
  const batchId = sub.body.batch_id;
  try {
    const rep = await get(maker, `/ingest/batch/${batchId}/exceptions`);
    assert.equal(rep.status, 200);
    assert.equal(rep.body.count, 2, 'the two genuinely-blocking rows are in the report (bad PF + mismatch)');
    assert.ok(rep.body.exceptions.every((e) => Array.isArray(e.reasons) && e.reasons.length > 0), 'each names its reasons');
    // The negative balance is NO LONGER an exception — it loads as a deficit.
    assert.ok(!rep.body.exceptions.some((e) => String(e.pf) === '90060002'),
      'the negative opening balance loads (deficit), not blocked (Omid ruling)');
  } finally {
    await purge(['90060001', '90060002', '90060003'], [batchId]);
  }
});

// ── Permits mirror: match by PF, unmatched → exception; maker-checker + load ──
test('permits: PF-matched loads to employee_document; unmatched goes to the exception report', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  const rows = [
    { pf: 'E-A-0001', name: 'Alice Admin', permit: 'Confined Space', expiry: '2027-01-01' }, // matches ALICE by PF
    { pf: '77777777', name: 'Ghost', permit: 'Orphan Permit', expiry: '2027-01-01' },          // no match
  ];
  const sub = await post(maker, '/ingest/permits/commit', { rows, control_totals: { count: 1 } });
  const batchId = sub.body.batch_id;
  assert.equal(sub.body.clean_count, 1);
  assert.equal(sub.body.exception_count, 1);
  try {
    const appr = await post(checker, '/ingest/permits/commit', { batch_id: batchId });
    assert.equal(appr.body.status, 'committed');
    assert.equal(appr.body.loaded, 1);
    const doc = (await owner(
      `SELECT kind, name, valid_until::text v FROM employee_document WHERE employee_id=$1 AND name='Confined Space'`, [F.EMP.ALICE])).rows[0];
    assert.ok(doc && doc.kind === 'permit' && doc.v === '2027-01-01', 'permit loaded to employee_document');
    const rep = await get(maker, `/ingest/batch/${batchId}/exceptions`);
    assert.ok(rep.body.exceptions.some((e) => e.reasons.join().includes('no employee match')));
  } finally {
    await owner(`DELETE FROM employee_document WHERE employee_id=$1 AND name='Confined Space'`, [F.EMP.ALICE]);
    await owner(`DELETE FROM ingest_batch WHERE id=$1`, [batchId]);
  }
});
