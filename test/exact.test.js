'use strict';
// Slice 8 — Exact payroll ingestion. Sample has NO data rows, so we build + test
// against synthetic fixtures in the confirmed layout. Covers schema validation,
// unmatched-record report, idempotent re-load, atomic publish, and the [TBC]
// blocks (match key, daily-rate set, NET PAY, reconciliation). AC-EXACT-07
// control-totals reconciliation is deferred to a real populated period.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const exact = require('../src/exact');
const cfg = require('../src/config');
const contractDef = require('../src/exact_contract');
const { F } = H;

const A = F.TENANT_A;
const session = { company_id: A, user_id: F.USERS.PAYMGR_A.id, role_code: 'R09' };

const CONTRACT = contractDef.build();
const N = CONTRACT.length;
const blank = () => Array(N).fill('');

// A well-formed grid: 5 preamble rows, section labels (row 6), headers (row 7), data.
function validGrid(dataRows = []) {
  const g = [['Exact Payroll Export', ...Array(N - 1).fill('')]];
  for (let i = 0; i < 4; i++) g.push(blank());
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

const setCfg = (key, value) => db.withOwner((c) =>
  c.query('UPDATE config SET value=$1 WHERE company_id=$2 AND key=$3', [value, A, key]));
const blockCfg = (key) => setCfg(key, cfg.PENDING);

before(H.start);
after(H.stop);

// ── Schema validation rejects a malformed file (AC-EXACT-01/02/03) ──────────
test('schema validation accepts the exact layout and rejects malformed files', async () => {
  // valid layout stages
  const ok = await exact.stage(session, { period: '2026-06', grid: validGrid([dataRow('E-A-0001', 'Alice Admin')]) });
  assert.equal(ok.status, 'staged');
  assert.equal(ok.row_count, 1);

  // wrong column count
  const short = validGrid([dataRow('E-A-0001', 'x')]);
  short[6] = short[6].slice(0, N - 1); // header row missing a column
  await assert.rejects(exact.stage(session, { grid: short }), /layout invalid/);

  // renamed pinned header
  const renamed = validGrid();
  renamed[6][0] = 'EMP'; // was 'EMPLOYEE ID'
  await assert.rejects(exact.stage(session, { grid: renamed }), /layout invalid/);

  // header row absent (file too short)
  await assert.rejects(exact.stage(session, { grid: validGrid().slice(0, 6) }), /layout invalid/);
});

// ── Unmatched-record report (AC-EXACT-04/05) ────────────────────────────────
test('match produces an unmatched-record report (mapping from the registry)', async () => {
  await setCfg('exact.match.key', 'legacy_id');
  try {
    const staged = await exact.stage(session, { period: '2026-06-unmatched',
      grid: validGrid([dataRow('E-A-0001', 'Alice'), dataRow('E-A-9999', 'Ghost')]) });
    const rep = await exact.match(session, staged.batch_id);
    assert.equal(rep.key, 'legacy_id');
    assert.equal(rep.matched, 1);
    assert.deepEqual(rep.unmatched.map((u) => u.employee_id), ['E-A-9999']);
  } finally {
    await blockCfg('exact.match.key');
  }
});

// ── Idempotent re-load (AC-EXACT-06) ────────────────────────────────────────
test('re-loading the identical file is idempotent (one batch, no duplicate rows)', async () => {
  const grid = validGrid([dataRow('E-A-0001', 'Alice'), dataRow('E-A-0002', 'Carol')]);
  const first = await exact.stage(session, { period: '2026-06-idem', grid });
  assert.equal(first.deduped, false);
  const again = await exact.stage(session, { period: '2026-06-idem', grid });
  assert.equal(again.deduped, true);
  assert.equal(again.batch_id, first.batch_id);

  const rows = await db.withOwner((c) => c.query(
    'SELECT count(*)::int n FROM exact_row WHERE batch_id=$1', [first.batch_id]));
  assert.equal(rows.rows[0].n, 2, 'rows not duplicated on re-load');
  const batches = await db.withOwner((c) => c.query(
    'SELECT count(*)::int n FROM exact_batch WHERE company_id=$1 AND period=$2', [A, '2026-06-idem']));
  assert.equal(batches.rows[0].n, 1, 'single batch for the same file');
});

// ── Atomic publish (AC-EXACT-08) ────────────────────────────────────────────
test('publish is atomic — an injected fault rolls back; a clean run publishes once', async () => {
  await setCfg('exact.match.key', 'legacy_id');
  try {
    const staged = await exact.stage(session, { period: '2026-06-pub',
      grid: validGrid([dataRow('E-A-0001', 'Alice'), dataRow('E-A-0002', 'Carol')]) });
    await exact.match(session, staged.batch_id);

    // mid-publish fault → nothing commits, batch stays staged
    await assert.rejects(exact.publish(session, staged.batch_id, { faultStep: 'after_status' }), /injected fault/);
    let st = (await db.withOwner((c) => c.query('SELECT status FROM exact_batch WHERE id=$1', [staged.batch_id]))).rows[0];
    assert.equal(st.status, 'staged', 'faulted publish left the batch staged');

    // clean publish
    const pub = await exact.publish(session, staged.batch_id);
    assert.equal(pub.status, 'published');
    st = (await db.withOwner((c) => c.query('SELECT status FROM exact_batch WHERE id=$1', [staged.batch_id]))).rows[0];
    assert.equal(st.status, 'published');
    const aud = await db.withOwner((c) => c.query(
      `SELECT count(*)::int n FROM audit WHERE action='exact.publish' AND entity_id=$1`, [staged.batch_id]));
    assert.equal(aud.rows[0].n, 1, 'publish audited');
  } finally {
    await blockCfg('exact.match.key');
  }
});

// ── [TBC] items BLOCK, they do not default ──────────────────────────────────
test('[TBC] match key, daily-rate set, net-pay source and reconciliation all BLOCK', async () => {
  const staged = await exact.stage(session, { period: '2026-06-tbc', grid: validGrid([dataRow('E-A-0001', 'Alice')]) });
  await assert.rejects(exact.match(session, staged.batch_id), /pending governance/); // match key [TBC]
  await assert.rejects(exact.dailyRateBase(session, {}), /pending governance/);
  await assert.rejects(exact.netPay(session, {}), /pending governance/);
  await assert.rejects(exact.reconcile(session, staged.batch_id), /pending governance/); // AC-EXACT-07 gated
});
