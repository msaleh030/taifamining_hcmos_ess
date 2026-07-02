'use strict';
// F6 — Exact payroll integration as INTEGRATION tests through the real HTTP
// endpoints. The pipeline: upload → schema-validate → reconcile (unmatched
// report) → net-check → control-totals → publish. The SAFETY NETS are the
// must-prove, and every one is a HARD BLOCK at the endpoint, not a warning:
//   • schema-invalid file → 422, nothing ingested (EXACT-01/02/03);
//   • unmatched rows incl. a TMCL-only joiner land in the report (EXACT-04/05);
//   • idempotent re-load (EXACT-06); per-row net check runs (EXACT-07);
//   • atomic publish — an injected fault commits nothing (EXACT-08);
//   • control-totals mismatch BLOCKS publish (EXACT-09);
//   • published pay is READ-ONLY — re-publish refused, no mutation route (EXACT-10).
// All endpoints are guarded to the pay-visibility set (a3.pay.roles), the same
// pay-adjacent discipline as liability.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const contractDef = require('../src/exact_contract');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;

const CONTRACT = contractDef.build();
const N = CONTRACT.length;

// Build a valid grid (two-row header at rows 6/7) with the given data rows.
function validGrid(dataRows = []) {
  const g = [['Exact Payroll Export', ...Array(N - 1).fill('')]];
  for (let i = 0; i < 4; i++) g.push(Array(N).fill(''));
  g.push(CONTRACT.map((c) => c.section.toUpperCase())); // row 6 — section labels
  g.push(CONTRACT.map((c) => c.header));                // row 7 — column headers
  for (const d of dataRows) g.push(d);
  return g;
}
function dataRow(empId, name, over = {}) {
  const r = Array(N).fill('0');
  r[0] = empId; r[1] = name; r[3] = '2020-01-01'; r[4] = 'Mining';
  for (const [k, v] of Object.entries(over)) r[k] = v;
  return r;
}
// Serialize a grid to CSV text so the endpoint exercises the real file parser.
const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (grid) => grid.map((r) => r.map(csvCell).join(',')).join('\n');

const upload = (token, body) => H.req('POST', '/exact/upload', { token, body });
const post = (token, path) => H.req('POST', path, { token });
const get = (token, path) => H.req('GET', path, { token });

// A row with total_pay@28, total_deduction@42, col-AS net@44.
const payRow = (id, name, tp, td, as) => dataRow(id, name, { 28: String(tp), 42: String(td), 44: String(as) });

before(H.start);
after(H.stop);

// ── EXACT-01/02/03 + guard: schema validation + pay-role guard, at the endpoint ─
test('EXACT-01/02/03 schema validation blocks malformed files; endpoint is pay-guarded', async () => {
  const pay = await tok(F.USERS.FINMGR_A); // R15 ∈ a3.pay.roles (v1.5)
  const emp = await tok(F.USERS.EMP_A);    // R01 ∉ a3.pay.roles

  // Guard: a non-pay role cannot run the payroll upload (same discipline as liability).
  assert.equal((await upload(emp, { csv: toCsv(validGrid([dataRow('E-A-0001', 'A-guard')])) })).status, 403,
    'a role that cannot see pay cannot upload payroll');

  // Valid file → staged.
  const ok = await upload(pay, { period: '2026-06-f6-ok', csv: toCsv(validGrid([dataRow('E-A-0001', 'A-ok')])) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'staged');
  assert.equal(ok.body.row_count, 1);

  // Wrong column count → 422, nothing ingested.
  const short = validGrid([dataRow('E-A-0001', 'x')]);
  short[6] = short[6].slice(0, N - 1);
  const shortRes = await upload(pay, { csv: toCsv(short) });
  assert.equal(shortRes.status, 422, 'wrong column count rejected at the endpoint');

  // Renamed pinned header → 422.
  const renamed = validGrid([dataRow('E-A-0001', 'x')]);
  renamed[6][0] = 'EMP';
  assert.equal((await upload(pay, { csv: toCsv(renamed) })).status, 422, 'renamed header rejected');

  // Not ingested: no staged batch exists for these malformed uploads.
  const staged = Number((await owner(`SELECT count(*)::int n FROM exact_batch WHERE company_id=$1 AND period IS NULL`, [A])).rows[0].n);
  assert.equal(staged, 0, 'a rejected file leaves no batch — nothing partially ingested');
});

// ── EXACT-04/05: reconcile → unmatched report incl. a TMCL-only joiner ──────
test('EXACT-04/05 reconcile matches on legacy_id; ghost + TMCL-only joiner surface as unmatched', async () => {
  const pay = await tok(F.USERS.FINMGR_A);
  const up = await upload(pay, { period: '2026-06-f6-match', csv: toCsv(validGrid([
    dataRow('E-A-0001', 'A-match'),       // legacy_id → matches
    dataRow('E-A-9999', 'G-match'),       // no such legacy_id → unmatched
    dataRow('TMCL-NM-0007', 'J-match'),   // TMCL-only joiner, no legacy_id → unmatched
  ])) });
  assert.equal(up.status, 200);

  const rep = await post(pay, `/exact/batch/${up.body.batch_id}/reconcile`);
  assert.equal(rep.status, 200);
  assert.equal(rep.body.key, 'legacy_id');
  assert.equal(rep.body.matched, 1);
  assert.deepEqual(rep.body.unmatched.map((u) => u.employee_id).sort(), ['E-A-9999', 'TMCL-NM-0007']);
});

// ── EXACT-06: idempotent re-load ────────────────────────────────────────────
test('EXACT-06 re-loading the identical file is idempotent (one batch)', async () => {
  const pay = await tok(F.USERS.FINMGR_A);
  const csv = toCsv(validGrid([dataRow('E-A-0001', 'A-idem'), dataRow('E-A-0002', 'C-idem')]));
  const first = await upload(pay, { period: '2026-06-f6-idem', csv });
  assert.equal(first.body.deduped, false);
  const again = await upload(pay, { period: '2026-06-f6-idem', csv });
  assert.equal(again.body.deduped, true);
  assert.equal(again.body.batch_id, first.body.batch_id);
});

// ── EXACT-07: per-row net check runs (computed net == col AS) ────────────────
test('EXACT-07 per-row net check runs at the endpoint (computed net == col AS)', async () => {
  const pay = await tok(F.USERS.FINMGR_A);
  const up = await upload(pay, { period: '2026-06-f6-net', csv: toCsv(validGrid([
    payRow('E-A-0001', 'A-net', 1000, 300, 700), // net 700 == AS 700 → ok
    payRow('E-A-0002', 'C-net', 1000, 300, 999), // net 700 != AS 999 → mismatch
  ])) });
  const nc = await get(pay, `/exact/batch/${up.body.batch_id}/net-check`);
  assert.equal(nc.status, 200);
  assert.equal(nc.body.checked, 2);
  assert.deepEqual(nc.body.mismatches.map((m) => m.row_no), [2]);
});

// ── EXACT-08: atomic publish — an injected mid-publish fault commits nothing ──
test('EXACT-08 publish is atomic: an injected fault rolls back; a clean run publishes once', async () => {
  const pay = await tok(F.USERS.FINMGR_A);
  const up = await upload(pay, { period: '2026-06-f6-atomic', control_totals: { total_pay: 3000, total_deduction: 800, net: 2200 },
    csv: toCsv(validGrid([payRow('E-A-0001', 'A-atomic', 1000, 300, 700), payRow('E-A-0002', 'C-atomic', 2000, 500, 1500)])) });
  await post(pay, `/exact/batch/${up.body.batch_id}/reconcile`);

  const faulted = await H.req('POST', `/exact/batch/${up.body.batch_id}/publish`, { token: pay, body: { faultStep: 'after_status' } });
  assert.notEqual(faulted.status, 200, 'faulted publish did not succeed');
  const mid = await get(pay, `/exact/batch/${up.body.batch_id}`);
  assert.equal(mid.body.batch.status, 'staged', 'injected fault committed nothing — still staged');

  const pub = await post(pay, `/exact/batch/${up.body.batch_id}/publish`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.status, 'published');
});

// ── EXACT-09: control-totals mismatch BLOCKS publish (not a warning) ─────────
test('EXACT-09 a file whose control totals do not reconcile BLOCKS publish', async () => {
  const pay = await tok(F.USERS.FINMGR_A);
  // Declared net (9999) does not match the summed rows (700+1500 = 2200).
  const up = await upload(pay, { period: '2026-06-f6-ctrl', control_totals: { net: 9999 },
    csv: toCsv(validGrid([payRow('E-A-0001', 'A-ctrl', 1000, 300, 700), payRow('E-A-0002', 'C-ctrl', 2000, 500, 1500)])) });
  await post(pay, `/exact/batch/${up.body.batch_id}/reconcile`);

  // The report shows the mismatch…
  const rep = await get(pay, `/exact/batch/${up.body.batch_id}/control-totals`);
  assert.equal(rep.body.ok, false);
  assert.equal(rep.body.computed.net, 2200);

  // …and publish is a HARD BLOCK, not a warning that can be clicked past.
  const pub = await post(pay, `/exact/batch/${up.body.batch_id}/publish`);
  assert.equal(pub.status, 409, 'control-totals mismatch blocks publish');
  assert.ok(pub.body.mismatches.some((m) => m.field === 'net'));
  const after = await get(pay, `/exact/batch/${up.body.batch_id}`);
  assert.equal(after.body.batch.status, 'staged', 'blocked publish left the batch staged (nothing published)');
});

// ── EXACT-10: published pay is READ-ONLY (re-publish refused; no mutation route) ─
test('EXACT-10 a published batch is read-only — re-publish is refused, no endpoint mutates pay', async () => {
  const pay = await tok(F.USERS.FINMGR_A);
  const up = await upload(pay, { period: '2026-06-f6-ro', control_totals: { total_pay: 1000, total_deduction: 300, net: 700 },
    csv: toCsv(validGrid([payRow('E-A-0001', 'A-ro', 1000, 300, 700)])) });
  await post(pay, `/exact/batch/${up.body.batch_id}/reconcile`);
  assert.equal((await post(pay, `/exact/batch/${up.body.batch_id}/publish`)).body.status, 'published');

  const view = await get(pay, `/exact/batch/${up.body.batch_id}`);
  assert.equal(view.body.batch.status, 'published');
  assert.equal(view.body.read_only, true, 'the batch reports read-only once published');

  // Re-publish is refused (published pay cannot be mutated/re-run).
  assert.equal((await post(pay, `/exact/batch/${up.body.batch_id}/publish`)).status, 409, 'already published — no re-publish');

  // There is no write route for a row: an arbitrary mutation verb is not served.
  assert.equal((await H.req('PUT', `/exact/batch/${up.body.batch_id}`, { token: pay, body: { status: 'staged' } })).status, 404,
    'no endpoint mutates a published batch');
});

// ── EXACT-11: publish fan-out reports PER-LEG status; retry is scoped to the
// failed leg and never double-posts the GL ──────────────────────────────────
test('EXACT-11 publish fan-out is per-leg; a scoped retry fixes ESS without double-posting GL', async () => {
  const pay = await tok(F.USERS.FINMGR_A);
  const glCount = async (bid) => Number((await owner(`SELECT count(*)::int n FROM gl_posting WHERE batch_id=$1`, [bid])).rows[0].n);
  const essCount = async (bid) => Number((await owner(`SELECT count(*)::int n FROM ess_push WHERE batch_id=$1`, [bid])).rows[0].n);

  const up = await upload(pay, { period: '2026-06-f6-legs', control_totals: { total_pay: 1000, total_deduction: 300, net: 700 },
    csv: toCsv(validGrid([payRow('E-A-0001', 'A-legs', 1000, 300, 700)])) });
  const bid = up.body.batch_id;
  await post(pay, `/exact/batch/${bid}/reconcile`);

  // Publish with the ESS leg forced to fail → partial state: GL posted, ESS failed.
  const pub = await H.req('POST', `/exact/batch/${bid}/publish`, { token: pay, body: { faultLeg: 'ess' } });
  assert.equal(pub.status, 200, 'the batch still publishes — a failed leg is a partial state, not a rollback');
  assert.equal(pub.body.status, 'published');
  assert.equal(pub.body.legs.gl.status, 'posted', 'GL leg posted');
  assert.equal(pub.body.legs.ess.status, 'failed', 'ESS leg failed (reported per-leg, not a blanket fail)');
  assert.equal(await glCount(bid), 1, 'GL posted exactly once');
  assert.equal(await essCount(bid), 0, 'ESS did not post');

  // The read-only view reflects the partial state.
  const mid = await get(pay, `/exact/batch/${bid}`);
  assert.equal(mid.body.legs.gl.status, 'posted');
  assert.equal(mid.body.legs.ess.status, 'failed');

  // Scoped retry (no fault): re-drives ONLY the non-posted legs. GL is skipped.
  const retry = await post(pay, `/exact/batch/${bid}/publish/retry`);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.legs.ess.status, 'posted', 'ESS pushed on retry');
  assert.equal(retry.body.legs.gl.skipped, true, 'GL leg was skipped (already posted) — not re-attempted');
  assert.equal(await glCount(bid), 1, 'GL still posted exactly once — no double-post from the retry');
  assert.equal(await essCount(bid), 1, 'ESS now pushed exactly once');
});
