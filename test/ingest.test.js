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
    // Site-level PF: one number may hold rows at SEVERAL sites — purge them all.
    const rows = (await owner(`SELECT id FROM employee WHERE legacy_id=$1`, [pf])).rows;
    for (const e of rows) {
      await owner(`DELETE FROM leave_carry_sweep WHERE employee_id=$1`, [e.id]);
      await owner(`DELETE FROM leave_carry WHERE employee_id=$1`, [e.id]);
      await owner(`DELETE FROM employee_document WHERE employee_id=$1`, [e.id]);
      await owner(`DELETE FROM employee_pay WHERE employee_id=$1`, [e.id]);
      await owner(`UPDATE employee SET manager_id=NULL WHERE manager_id=$1`, [e.id]);
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

// ── EM: employee-master load populates the directory; identity gated correctly ─
const EMP = '/ingest/employee-master/preview';
const EMC = '/ingest/employee-master/commit';
test('EM-1 employee-master load creates directory-visible employees; identity columns land; confidential fields gated', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  const rows = [
    { pf: '95000001', name: 'Zznm Alpha Master', site: 'North Mara', position: 'ADT Operator',
      department: 'Production', hire_date: '2022-01-13 19:25:45', national_id: '19770205-16113-00001-20',
      tin: '116013487', bank: 'CRDB BANK LTD Azikiwe' },
    { pf: '95000002', name: 'Zznm Beta Master', site: 'North Mara', position: 'Boiler Maker',
      department: 'PLI & PED', hire_date: '2023-03-01 13:50:50', national_id: '',  // blank → warn, load anyway
      tin: '', bank: 'CRDB BANK LTD Lumumba' },
  ];
  const control_totals = [{ site: 'North Mara', count: 2 }];
  // preview: clean split + warnings for the blank national_id
  const prev = await post(maker, EMP, { rows, control_totals });
  assert.equal(prev.body.clean_count, 2);
  assert.equal(prev.body.control.ok, true, 'headcount control (285-style) reconciles');
  assert.ok(prev.body.clean.some((r) => r.warnings.join().includes('national_id missing')), 'blank national_id is a punch-list warning, not a block');

  const sub = await post(maker, EMC, { rows, control_totals });
  const batchId = sub.body.batch_id;
  try {
    const appr = await post(checker, EMC, { batch_id: batchId });
    assert.equal(appr.body.status, 'committed');
    assert.equal(appr.body.loaded, 2);

    const e = await empByPf('95000001');
    assert.ok(e && e.site_id === F.SITE.A1, 'employee created, scoped to North Mara');
    const row = (await owner(
      `SELECT emp_no, position, dept, joined_at::text jd FROM employee WHERE id=$1`, [e.id])).rows[0];
    assert.equal(row.emp_no, '95000001', 'PF is the emp_no');
    assert.equal(row.position, 'ADT Operator', 'position (job title) stored');
    assert.equal(row.dept, 'Production', 'department stored');
    assert.equal(row.jd, '2022-01-13', 'hire_date time-portion dropped to a join date');
    const pay = (await owner(
      `SELECT bank_name, national_id, tin FROM employee_pay WHERE employee_id=$1`, [e.id])).rows[0];
    assert.equal(pay.bank_name, 'CRDB BANK LTD Azikiwe', 'bank stored confidentially');
    assert.equal(pay.national_id, '19770205-16113-00001-20');
    assert.equal(pay.tin, '116013487');

    // DIRECTORY: a site-scoped HR user (R03 @ North Mara) sees the loaded rows
    // with position, but NOT the confidential identity.
    const dir = await get(await tok(F.USERS.HR_A), '/employees?q=Zznm');
    assert.equal(dir.status, 200);
    const listed = dir.body.rows.find((r) => r.id === e.id);
    assert.ok(listed, 'the loaded employee is in the directory');
    assert.equal(listed.position, 'ADT Operator', 'position is directory-visible');
    assert.ok(!('national_id' in listed) && !('tin' in listed) && !('bank_name' in listed), 'confidential identity absent from the directory row');

    // PROFILE: R03 (HR tier, Kira 2026-07-09) — national_id VISIBLE (core HR
    // identifier); tin/bank remain pay-gated and ABSENT (not masked).
    const asHr = await get(await tok(F.USERS.HR_A), `/employees/${e.id}`);
    assert.equal(asHr.body.position, 'ADT Operator');
    assert.equal(asHr.body.national_id, '19770205-16113-00001-20', 'national_id is HR-visible (R03 and up)');
    assert.ok(!('tin' in asHr.body) && !('bank_name' in asHr.body) && !('basic_pay' in asHr.body),
      'C5: tin/bank/pay stay behind the pay gate — absent for R03, never masked');
    // PROFILE: R07 (payroll, pay gate) — sees everything.
    const asPay = await get(await tok(F.USERS.PAYROLL_A), `/employees/${e.id}`);
    assert.equal(asPay.body.national_id, '19770205-16113-00001-20', 'payroll sees national_id');
    assert.equal(asPay.body.tin, '116013487', 'pay-gated role sees tin');
    assert.equal(asPay.body.bank_name, 'CRDB BANK LTD Azikiwe', 'pay-gated role sees bank');
  } finally {
    await purge(['95000001', '95000002'], [batchId]);
  }
});

test('EM-2 a PF match with a DIFFERENT name/site is an exception (identity ambiguity), never a silent overwrite', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  const rows = [{ pf: '95020001', name: 'Zznm Dup Master', site: 'North Mara', position: 'X', department: 'Admin', hire_date: '2020-01-01' }];
  const sub = await post(maker, EMC, { rows, control_totals: [{ site: 'North Mara', count: 1 }] });
  const batchId = sub.body.batch_id;
  try {
    await post(checker, EMC, { batch_id: batchId });
    // Same PF, DIFFERENT name → exception (could be a different person on a reused PF).
    const diff = await post(maker, EMP, {
      rows: [{ pf: '95020001', name: 'Someone Else Entirely', site: 'North Mara', position: 'Y', department: 'Admin', hire_date: '2020-01-01' }],
      control_totals: [{ site: 'North Mara', count: 0 }] });
    assert.equal(diff.body.exception_count, 1);
    assert.ok(diff.body.exceptions[0].exceptions.join().match(/DIFFERENT name.*refusing to overwrite/));
  } finally {
    await purge(['95020001'], [batchId]);
  }
});

test('EM-5 ENRICH: a PF-matched (name-verified) row created by an earlier balance load is filled in, not duplicated', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  // Simulate the box state: an earlier opening-balance load created the employee
  // by PF with identity fields MISSING (position null, no pay row), + a balance.
  const obSub = await post(maker, OBC, {
    rows: [{ pf: '95040001', name: 'Zznm Enrich Target', site: 'North Mara', accrued: 8, taken: 0, balance: 8 }],
    control_totals: [{ site: 'North Mara', count: 1, sum_balance: 8 }] });
  await post(checker, OBC, { batch_id: obSub.body.batch_id });
  const e0 = await empByPf('95040001');
  assert.ok(e0, 'balance load created the bare employee');
  const before = (await owner(`SELECT position, dept FROM employee WHERE id=$1`, [e0.id])).rows[0];
  assert.equal(before.position, null, 'no identity yet (bare, from the balance load)');
  const empCount = async () => Number((await owner(`SELECT count(*)::int n FROM employee WHERE legacy_id='95040001'`)).rows[0].n);
  const carry = async () => Number((await owner(`SELECT coalesce(sum(days),0)::float8 d FROM leave_carry WHERE employee_id=$1 AND opening_bucket=true`, [e0.id])).rows[0].d);
  const emRows = [{ pf: '95040001', name: 'Zznm Enrich Target', site: 'North Mara', position: 'Boiler Maker',
    department: 'PLI & PED', hire_date: '2022-02-01', national_id: '19680515-14130-00001-23', tin: '146475558', bank: 'CRDB' }];
  const emCtl = [{ site: 'North Mara', count: 1 }];
  let emBatch;
  try {
    // Preview shows the enrich as CLEAN with the "enriching" warning (not an exception).
    const emPrev = await post(maker, EMP, { rows: emRows, control_totals: emCtl });
    assert.equal(emPrev.body.clean_count, 1, 'the pre-existing PF is clean (enrich), not an exception');
    assert.ok(emPrev.body.clean[0].warnings.join().includes('enriching an existing employee'));
    // Master enriches the SAME record (name matches) — no duplicate; leave kept.
    const emSub = await post(maker, EMC, { rows: emRows, control_totals: emCtl });
    emBatch = emSub.body.batch_id;
    const appr = await post(checker, EMC, { batch_id: emBatch });
    assert.equal(appr.body.loaded, 1);
    assert.equal(await empCount(), 1, 'no duplicate employee — the master enriched the existing record');
    const after = (await owner(`SELECT position, dept, joined_at::text jd, emp_no FROM employee WHERE id=$1`, [e0.id])).rows[0];
    assert.equal(after.position, 'Boiler Maker', 'identity filled in');
    assert.equal(after.dept, 'PLI & PED');
    assert.equal(after.emp_no, '95040001', 'emp_no backfilled from PF');
    assert.equal(await carry(), 8, 'the pre-existing leave balance is untouched');
    const pay = (await owner(`SELECT national_id, tin, bank_name FROM employee_pay WHERE employee_id=$1`, [e0.id])).rows[0];
    assert.equal(pay.national_id, '19680515-14130-00001-23', 'confidential identity attached');
    assert.equal(pay.tin, '146475558');
  } finally {
    await purge(['95040001'], [obSub.body.batch_id, emBatch].filter(Boolean));
  }
});

test('EM-4 format anomalies are FLAGGED on the punch-list but the row loads VERBATIM (never "fixed")', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const rows = [
    // tin 6 digits (TRA is 9); NIDA 12 digits (NIDA is 20); future hire_date.
    { pf: '95030001', name: 'Zznm Anomaly One', site: 'North Mara', position: 'Welder',
      department: 'Production', hire_date: '2036-01-01', national_id: '141300000227', tin: '123456' },
    // Two rows sharing one national_id + tin — a real North Mara data pattern.
    { pf: '95030002', name: 'Zznm Twin A', site: 'North Mara', position: 'Spotter',
      department: 'Production', hire_date: '2024-01-01', national_id: '19770424-11101-00003-25', tin: '143578895' },
    { pf: '95030003', name: 'Zznm Twin B', site: 'North Mara', position: 'Spotter',
      department: 'Production', hire_date: '2024-01-01', national_id: '19770424-11101-00003-25', tin: '143578895' },
  ];
  const prev = await post(maker, EMP, { rows, control_totals: [{ site: 'North Mara', count: 3 }] });
  assert.equal(prev.body.clean_count, 3, 'anomalies WARN — they never block a load (only ambiguity/policy does)');
  const w = (pf) => prev.body.clean.find((r) => r.pf === pf).warnings.join(' | ');
  assert.match(w('95030001'), /tin format anomaly "123456" \(TRA TIN is 9 digits\)/);
  assert.match(w('95030001'), /national_id length anomaly \(12 digits; NIDA is 20\)/);
  assert.match(w('95030001'), /hire_date 2036-01-01 is in the future/);
  assert.match(w('95030002'), /national_id shared by more than one row/);
  assert.match(w('95030003'), /tin shared by more than one row/);
  // Values pass through VERBATIM — flagged, not "corrected".
  const n = prev.body.clean.find((r) => r.pf === '95030001').normalized;
  assert.equal(n.tin, '123456');
  assert.equal(n.national_id, '141300000227');
});

// ── Re-attach: opening balances match the master by PF instead of failing ─────
test('EM-3 after the master load, an opening-balance load ATTACHES to the existing employee (no duplicate) and is idempotent', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  // 1) master creates the employee (no balance yet)
  const emRows = [{ pf: '95010001', name: 'Zznm Attach Master', site: 'North Mara', position: 'Mechanic', department: 'PLI & PED', hire_date: '2021-05-01' }];
  const emSub = await post(maker, EMC, { rows: emRows, control_totals: [{ site: 'North Mara', count: 1 }] });
  await post(checker, EMC, { batch_id: emSub.body.batch_id });
  const e = await empByPf('95010001');
  const empCount = async () => Number((await owner(`SELECT count(*)::int n FROM employee WHERE legacy_id='95010001'`)).rows[0].n);
  const carrySum = async () => Number((await owner(
    `SELECT coalesce(sum(days),0)::float8 d FROM leave_carry WHERE employee_id=$1 AND opening_bucket=true`, [e.id])).rows[0].d);
  const obRows = [{ pf: '95010001', name: 'Zznm Attach Master', site: 'North Mara', accrued: 12, taken: 0, balance: 12 }];
  const obCtl = [{ site: 'North Mara', count: 1, sum_balance: 12 }];
  try {
    // 2) opening-balance load matches PF → attaches to the SAME employee
    const obSub = await post(maker, OBC, { rows: obRows, control_totals: obCtl });
    assert.ok(obSub.body.clean_count === 1, 'the balance is clean (matched), not a no-employee-match exception');
    const obAppr = await post(checker, OBC, { batch_id: obSub.body.batch_id });
    assert.equal(obAppr.body.loaded, 1);
    assert.equal(await empCount(), 1, 'no duplicate employee created — attached to the master record');
    assert.equal(await carrySum(), 12, 'balance attached to the opening bucket');

    // 3) idempotent re-run for the SAME year nets (replaces), does not double
    const obSub2 = await post(maker, OBC, { rows: obRows, control_totals: obCtl });
    await post(checker, OBC, { batch_id: obSub2.body.batch_id });
    assert.equal(await empCount(), 1, 'still one employee');
    assert.equal(await carrySum(), 12, 're-run replaced the same-year opening bucket, not doubled to 24');
  } finally {
    await purge(['95010001'], [emSub.body.batch_id]);
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

// ── Six-site model (Kira 2026-07-12): rich fields, tiering, site correction,
// reporting split, shortfall-tolerant controls ────────────────────────────────
test('EM-6 rich fields land in their tiers; a BARE row is site-corrected; a MASTERED row never moves', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  const site2 = (await owner(`INSERT INTO site(company_id,name) VALUES ($1,'Zz Project Site') RETURNING id`, [F.TENANT_A])).rows[0].id;
  // A bare row (balances-load shape: no position) at North Mara.
  const bare = (await owner(
    `INSERT INTO employee(company_id, site_id, full_name, legacy_id, role_code, status)
     VALUES ($1,$2,'Zz Sitefix Person','95050001','R01','active') RETURNING id`, [F.TENANT_A, F.SITE.A1])).rows[0].id;
  const rows = [
    // Enrich + MOVE the bare row to the project site, with the full rich set.
    { pf: '95050001', first_name: 'Zz', middle_name: 'Sitefix', surname: 'Person', site: 'Zz Project Site',
      position: 'Rigger', department: 'Production', level: 'Grade 2', employment_type: 'Specific Task',
      hire_date: '2024-05-01', email: 'zz.sitefix@taifamining.co.tz', phone: '0755000111',
      reports_to_title: 'Workshop Manager', national_id: '19900101141010000121', tin: '123456789',
      date_of_birth: '1990-01-01', gender: 'Male', bank_name: 'CRDB', bank_account: '0150999',
      passport_number: 'AB123456', citizenship: 'Tanzanian', nssf_number: 'NSSF-9', full_address: 'PO Box 9',
      nok_relationship: 'Spouse', nok_name: 'Zz Kin', nok_contact: '0755000112' },
  ];
  const ct = [{ site: 'Zz Project Site', count: 1 }];
  const sub = await post(maker, EMC, { rows, control_totals: ct });
  try {
    assert.equal(sub.body.clean_count, 1, 'bare row at another site is clean (site-correct), not an exception');
    await post(checker, EMC, { batch_id: sub.body.batch_id });
    const e = (await owner(`SELECT site_id, position, level, employment_type, reports_to_title, email FROM employee WHERE id=$1`, [bare])).rows[0];
    assert.equal(e.site_id, site2, 'BARE row moved to the master\'s authoritative site');
    assert.equal(e.position, 'Rigger');
    assert.equal(e.level, 'Grade 2');
    assert.equal(e.employment_type, 'Specific Task');
    assert.equal(e.reports_to_title, 'Workshop Manager', 'reporting title stored as TEXT — no fabricated person link');
    assert.equal(e.email, 'zz.sitefix@taifamining.co.tz');
    const manager = (await owner(`SELECT manager_id FROM employee WHERE id=$1`, [bare])).rows[0];
    assert.equal(manager.manager_id, null, 'no manager link from a title');
    const pii = (await owner(`SELECT dob::text, gender, passport_number, nssf_number, nok_name FROM employee_pay WHERE employee_id=$1`, [bare])).rows[0];
    assert.equal(pii.dob, '1990-01-01');
    assert.equal(pii.passport_number, 'AB123456');
    assert.equal(pii.nok_name, 'Zz Kin');
    // Tier check: R03 (HR) profile shows the directory tier + national_id, NEVER the PII block.
    const asHr = await get(await tok(F.USERS.HR_A), `/employees/${bare}`);
    assert.equal(asHr.status, 404, 'R03 is site-scoped to A1; the moved employee is out of scope (fail closed)');
    const asPay = await get(await tok(F.USERS.PAYROLL_A), `/employees/${bare}`);
    assert.equal(asPay.body.passport_number, 'AB123456', 'pay/PII gate sees passport');
    assert.equal(asPay.body.nok_contact, '0755000112', 'pay/PII gate sees next-of-kin');
    assert.equal(asPay.body.reports_to_title, 'Workshop Manager', 'directory tier present');

    // Kira ruling (2026-07-12, site-level PF): a MASTERED row at another site no
    // longer blocks a second site's claim — the duplicate LOADS as a NEW
    // employee at ITS site, FLAGGED for Head of HR correction. Never a move,
    // never a merge, never an exclusion. The mastered original never moves.
    const again = await post(maker, EMP, {
      rows: [{ pf: '95050001', first_name: 'Zz', middle_name: 'Sitefix', surname: 'Person', site: 'North Mara', position: 'X' }],
      control_totals: [{ site: 'North Mara', count: 1 }] });
    assert.equal(again.body.clean_count, 1, 'cross-site duplicate PF LOADS (clean + flagged), no longer an exception');
    const flag = again.body.clean[0].warnings.join();
    assert.ok(flag.includes('cross-site duplicate PF'), 'flagged for correction (pending Head of HR approval)');
    assert.ok(flag.includes('SAME name'), 'a same-name duplicate is called out — possibly one person in two site files');
    const sub2 = await post(maker, EMC, {
      rows: [{ pf: '95050001', first_name: 'Zz', middle_name: 'Sitefix', surname: 'Person', site: 'North Mara', position: 'X' }],
      control_totals: [{ site: 'North Mara', count: 1 }] });
    await post(checker, EMC, { batch_id: sub2.body.batch_id });
    const both = (await owner(`SELECT site_id, emp_no FROM employee WHERE legacy_id='95050001'`)).rows;
    assert.equal(both.length, 2, 'both site records exist — loaded, not merged or excluded');
    const original = both.find((r) => r.site_id === site2);
    assert.ok(original, 'the mastered original stays at its site (never moved)');
    const dup = both.find((r) => r.site_id === F.SITE.A1);
    assert.ok(dup && dup.emp_no === null,
      'the flagged duplicate carries the PF as legacy id ONLY — emp_no stays company-unique (unassigned)');
    await owner(`DELETE FROM ingest_batch WHERE id=$1`, [sub2.body.batch_id]);
  } finally {
    await purge(['95050001'], [sub.body.batch_id]);
    await owner(`DELETE FROM site WHERE id=$1`, [site2]);
  }
});

test('EM-7 allow_shortfall: a canonical headcount above the clean count is REPORTED, not blocking; overshoot still blocks', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  const rows = [
    { pf: '95060001', name: 'Zz Short One', site: 'North Mara', position: 'A', department: 'P', hire_date: '2024-01-01' },
    { pf: 'BADPF', name: 'Zz Short Bad', site: 'North Mara', position: 'B', department: 'P', hire_date: '2024-01-01' }, // exception
  ];
  // Canonical count 3, clean will be 1 → shortfall 2, allowed explicitly.
  const sub = await post(maker, EMC, { rows, control_totals: [{ site: 'North Mara', count: 3, allow_shortfall: true }] });
  try {
    assert.equal(sub.body.clean_count, 1);
    assert.deepEqual(sub.body.control.shortfalls, [{ site: 'NORTH MARA', expected: 3, loaded: 1, shortfall: 2 }],
      'the gap is REPORTED with the canonical number, never silently absorbed');
    const appr = await post(checker, EMC, { batch_id: sub.body.batch_id });
    assert.equal(appr.body.loaded, 1, 'the commit proceeds under an explicit allow_shortfall');
    // Overshoot: clean 1 > canonical 0 → hard block even with allow_shortfall.
    const over = await post(maker, EMC, {
      rows: [{ pf: '95060002', name: 'Zz Over One', site: 'North Mara', position: 'A', department: 'P', hire_date: '2024-01-01' }],
      control_totals: [{ site: 'North Mara', count: 0, allow_shortfall: true }] });
    assert.equal(over.body.control.ok, false, 'MORE clean rows than canonical still hard-blocks (catches dupes/wrong-site)');
  } finally {
    await purge(['95060001', '95060002'], [sub.body.batch_id]);
  }
});

test('EM-8 reporting_to_pf must RESOLVE: in-batch links set manager_id; unresolvable is an exception', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  const rows = [
    { pf: '95070001', name: 'Zz Boss', site: 'North Mara', position: 'Superintendent', department: 'P', hire_date: '2020-01-01' },
    { pf: '95070002', name: 'Zz Report', site: 'North Mara', position: 'Operator', department: 'P', hire_date: '2021-01-01',
      reporting_to_pf: '95070001' },                                    // resolves in-batch → links
    { pf: '95070003', name: 'Zz Orphan', site: 'North Mara', position: 'Operator', department: 'P', hire_date: '2021-01-01',
      reporting_to_pf: '99999999' },                                    // resolves to NOBODY → exception
  ];
  const sub = await post(maker, EMC, { rows, control_totals: [{ site: 'North Mara', count: 2, allow_shortfall: false }] });
  try {
    assert.equal(sub.body.clean_count, 2);
    assert.ok(sub.body.control.ok);
    await post(checker, EMC, { batch_id: sub.body.batch_id });
    const boss = await empByPf('95070001');
    const rep = (await owner(`SELECT manager_id FROM employee WHERE legacy_id='95070002'`)).rows[0];
    assert.equal(rep.manager_id, boss.id, 'a RESOLVED reporting_to_pf becomes a real manager link');
    const rp = await get(maker, `/ingest/batch/${sub.body.batch_id}/exceptions`);
    assert.ok(rp.body.exceptions.some((e) => e.reasons.join().includes('does not resolve')),
      'an unresolvable manager PF is an exception — no fabricated link');
  } finally {
    await purge(['95070001', '95070002', '95070003'], [sub.body.batch_id]);
  }
});

// ── Kira rulings 2026-07-12: email = login identity; payroll master pay-gated ─
test('EM-9 email discipline: a duplicate email (in-batch or already assigned) is an EXCEPTION, never a shared login', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  // In-batch duplicate: two people, one address → BOTH excepted.
  const dup = await post(maker, EMP, {
    rows: [
      { pf: '95090001', name: 'Zz Mail One', site: 'North Mara', position: 'A', email: 'shared.login@taifamining.tz' },
      { pf: '95090002', name: 'Zz Mail Two', site: 'North Mara', position: 'B', email: 'shared.login@taifamining.tz' },
    ],
    control_totals: [{ site: 'North Mara', count: 0 }] });
  assert.equal(dup.body.exception_count, 2, 'both rows excepted — never "first one wins"');
  assert.ok(dup.body.exceptions[0].exceptions.join().includes('duplicate email within this batch'));

  // Already assigned to a DIFFERENT employee: load one, then try to reuse the address.
  const sub = await post(maker, EMC, {
    rows: [{ pf: '95090003', name: 'Zz Mail Owner', site: 'North Mara', position: 'C', email: 'zz.mailowner@taifamining.tz' }],
    control_totals: [{ site: 'North Mara', count: 1 }] });
  try {
    await post(checker, EMC, { batch_id: sub.body.batch_id });
    const reuse = await post(maker, EMP, {
      rows: [{ pf: '95090004', name: 'Zz Mail Thief', site: 'North Mara', position: 'D', email: 'zz.mailowner@taifamining.tz' }],
      control_totals: [{ site: 'North Mara', count: 0 }] });
    assert.equal(reuse.body.exception_count, 1);
    assert.ok(reuse.body.exceptions[0].exceptions.join().includes('already assigned to a different employee'));
    // The OWNER re-enriching their own record with their own address stays clean.
    const self = await post(maker, EMP, {
      rows: [{ pf: '95090003', name: 'Zz Mail Owner', site: 'North Mara', position: 'C', email: 'zz.mailowner@taifamining.tz' }],
      control_totals: [{ site: 'North Mara', count: 1 }] });
    assert.equal(self.body.clean_count, 1, 'an employee\'s own address is not a collision with themselves');
  } finally {
    await purge(['95090001', '95090002', '95090003', '95090004'], [sub.body.batch_id]);
  }
});

const PMP = '/ingest/payroll-master/preview';
const PMC = '/ingest/payroll-master/commit';
test('PM-1 payroll master: verified PF-at-site rows land basic/gross behind the pay gate; payroll NEVER creates people', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const checker = await tok(F.USERS.CFC_A);
  // The employee master row must exist FIRST (Kira's load order).
  const em = await post(maker, EMC, {
    rows: [{ pf: '95100001', name: 'Zz Paid Person', site: 'North Mara', position: 'Fitter', department: 'PLI', hire_date: '2022-02-01' }],
    control_totals: [{ site: 'North Mara', count: 1 }] });
  try {
    await post(checker, EMC, { batch_id: em.body.batch_id });
    const rows = [{ pf: '95100001', name: 'Zz Paid Person', site: 'North Mara',
      basic_salary: '1,200,000', gross_salary: '1,500,000', currency: 'TZS', bank: 'CRDB', bank_account: '0150111' }];
    const prev = await post(maker, PMP, { rows, control_totals: [{ site: 'North Mara', count: 1, sum_basic: 1200000 }] });
    assert.equal(prev.status, 200);
    assert.equal(prev.body.clean_count, 1);
    assert.ok(prev.body.control.ok, 'count + sum_basic reconcile');
    const sub = await post(maker, PMC, { rows, control_totals: [{ site: 'North Mara', count: 1, sum_basic: 1200000 }] });
    const appr = await post(checker, PMC, { batch_id: sub.body.batch_id });
    assert.equal(appr.body.loaded, 1);
    const e = await empByPf('95100001');
    const pay = (await owner(`SELECT basic_salary::text b, gross_salary::text g, pay_currency FROM employee_pay WHERE employee_id=$1`, [e.id])).rows[0];
    assert.equal(pay.b, '1200000.00', 'basic landed (comma-parsed, verbatim value)');
    assert.equal(pay.g, '1500000.00');
    assert.equal(pay.pay_currency, 'TZS');
    // Behind the gate: an R03 profile read carries NO pay block at all.
    const asHr = await get(await tok(F.USERS.HR_A), `/employees/${e.id}`);
    assert.equal(asHr.status, 200);
    assert.ok(!('basic_salary' in asHr.body) && !('bank_account' in asHr.body), 'R03 sees no pay fields');
    await owner(`DELETE FROM ingest_batch WHERE id=$1`, [sub.body.batch_id]);
  } finally {
    await purge(['95100001'], [em.body.batch_id]);
  }
});

test('PM-2 payroll master fail-closed: unknown PF at the site / name mismatch / no amount are EXCEPTIONS; nothing is created', async () => {
  const maker = await tok(F.USERS.FINMGR_A);
  const before = (await owner(`SELECT count(*)::int n FROM employee WHERE company_id=$1`, [F.TENANT_A])).rows[0].n;
  const prev = await post(maker, PMP, {
    rows: [
      { pf: '95119999', name: 'Zz Ghost', site: 'North Mara', basic_salary: '100000' },       // no such employee
      { pf: '95100001', name: 'Zz Paid Person', site: 'North Mara' },                          // (purged) no amount either
    ],
    control_totals: [] });
  assert.equal(prev.body.clean_count, 0, 'nothing clean');
  const reasons = prev.body.exceptions.map((e) => e.exceptions.join());
  assert.ok(reasons[0].includes('no employee with this PF at this site'), 'payroll never creates people');
  assert.ok(reasons[1].includes('neither basic nor gross'), 'an amountless payroll row is an exception');
  const after = (await owner(`SELECT count(*)::int n FROM employee WHERE company_id=$1`, [F.TENANT_A])).rows[0].n;
  assert.equal(after, before, 'no employee was created by a payroll preview');
});
