'use strict';
// Slice 8 — Exact payroll ingestion (registry v1.3). Sample has NO data rows, so
// we build + test against synthetic fixtures in the confirmed layout. Covers
// schema validation, legacy_id matching (EX-1) + unmatched report (incl. a
// TMCL-only joiner), idempotent re-load, atomic publish, the EX-2 daily-rate base
// (excludes overtime 21/24; Rotation/Night [TBC] default OUT), and the EX-3
// per-row net check (Total Pay − Total Deduction == col AS). Full-period
// control-totals reconciliation stays gated.
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
const blank = () => Array(N).fill('0');

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
before(H.start);
after(H.stop);

// ── Schema validation (AC-EXACT-01/02/03) ───────────────────────────────────
test('schema validation accepts the exact layout and rejects malformed files', async () => {
  const ok = await exact.stage(session, { period: '2026-06', grid: validGrid([dataRow('E-A-0001', 'Alice Admin')]) });
  assert.equal(ok.status, 'staged');
  assert.equal(ok.row_count, 1);

  const short = validGrid([dataRow('E-A-0001', 'x')]);
  short[6] = short[6].slice(0, N - 1);                 // wrong column count
  await assert.rejects(exact.stage(session, { grid: short }), /layout invalid/);

  const renamed = validGrid();
  renamed[6][0] = 'EMP';                                // renamed pinned header
  await assert.rejects(exact.stage(session, { grid: renamed }), /layout invalid/);

  await assert.rejects(exact.stage(session, { grid: validGrid().slice(0, 6) }), /layout invalid/); // no header row
});

// ── EX-1: match on legacy_id; unmatched report incl. TMCL-only joiner ───────
test('EX-1 match uses legacy_id; old IDs match, a TMCL-only joiner is unmatched', async () => {
  const staged = await exact.stage(session, { period: '2026-06-match',
    grid: validGrid([
      dataRow('E-A-0001', 'Alice'),        // old master-file ID → matches ALICE.legacy_id
      dataRow('E-A-9999', 'Ghost'),        // no such legacy_id → unmatched
      dataRow('TMCL-NM-0007', 'Jo Joiner'),// joiner with only a TMCL number → unmatched (EX-1)
    ]) });
  const rep = await exact.match(session, staged.batch_id);
  assert.equal(rep.key, 'legacy_id');
  assert.equal(rep.matched, 1, 'only the old-ID row matches');
  const unmatched = rep.unmatched.map((u) => u.employee_id).sort();
  assert.deepEqual(unmatched, ['E-A-9999', 'TMCL-NM-0007']);
});

// ── AC-EXACT-06: idempotent re-load ─────────────────────────────────────────
test('re-loading the identical file is idempotent (one batch, no duplicate rows)', async () => {
  const grid = validGrid([dataRow('E-A-0001', 'Alice'), dataRow('E-A-0002', 'Carol')]);
  const first = await exact.stage(session, { period: '2026-06-idem', grid });
  assert.equal(first.deduped, false);
  const again = await exact.stage(session, { period: '2026-06-idem', grid });
  assert.equal(again.deduped, true);
  assert.equal(again.batch_id, first.batch_id);

  const rows = await db.withOwner((c) => c.query('SELECT count(*)::int n FROM exact_row WHERE batch_id=$1', [first.batch_id]));
  assert.equal(rows.rows[0].n, 2, 'rows not duplicated');
});

// ── AC-EXACT-08: atomic publish ─────────────────────────────────────────────
test('publish is atomic — an injected fault rolls back; a clean run publishes once', async () => {
  const staged = await exact.stage(session, { period: '2026-06-pub',
    grid: validGrid([dataRow('E-A-0001', 'Alice'), dataRow('E-A-0002', 'Carol')]) });
  await exact.match(session, staged.batch_id);

  await assert.rejects(exact.publish(session, staged.batch_id, { faultStep: 'after_status' }), /injected fault/);
  let st = (await db.withOwner((c) => c.query('SELECT status FROM exact_batch WHERE id=$1', [staged.batch_id]))).rows[0];
  assert.equal(st.status, 'staged', 'faulted publish left the batch staged');

  const pub = await exact.publish(session, staged.batch_id);
  assert.equal(pub.status, 'published');
  const aud = await db.withOwner((c) => c.query(
    `SELECT count(*)::int n FROM audit WHERE action='exact.publish' AND entity_id=$1`, [staged.batch_id]));
  assert.equal(aud.rows[0].n, 1, 'publish audited');
});

// ── EX-3: per-row net check (Total Pay − Total Deduction == col AS) ──────────
test('EX-3 net check: computed net equals col AS, and a wrong col AS is flagged', async () => {
  // direct row check
  const good = await exact.netCheck(session, dataRow('E-A-0001', 'Alice', { 28: '1000', 42: '300', 44: '700' }));
  assert.deepEqual(good, { computed: 700, col_as: 700, ok: true });
  const bad = await exact.netCheck(session, dataRow('E-A-0002', 'Carol', { 28: '1000', 42: '300', 44: '999' }));
  assert.equal(bad.ok, false);
  assert.equal(bad.computed, 700);

  // batch check surfaces only the mismatching row (partial AC-EXACT-07)
  const staged = await exact.stage(session, { period: '2026-06-net',
    grid: validGrid([
      dataRow('E-A-0001', 'Alice', { 28: '1000', 42: '300', 44: '700' }),
      dataRow('E-A-0002', 'Carol', { 28: '1000', 42: '300', 44: '999' }),
    ]) });
  const res = await exact.netCheckBatch(session, staged.batch_id);
  assert.equal(res.checked, 2);
  assert.deepEqual(res.mismatches.map((m) => m.row_no), [2]);
});

// ── EX-2: daily-rate base is NAME-KEYED against the real Exact export ────────
// INCLUDE = Basic(12) Housing(13) Responsibility(14) Project(15) Medical(16)
// Housing All(17) Fixed Overtime(19) Transport(20); EXCLUDE = Rotation(11)
// Overtime-normal(21) Overtime-holiday(24) Night Shift(26).
test('EX-2 daily-rate base includes the fixed set (incl. Fixed Overtime + Transport); excludes Rotation/OT/Night', async () => {
  const cells = Array(N).fill('0');
  for (const p of [12, 13, 14, 15, 16, 17, 19, 20]) cells[p] = '100'; // 8 included → 800
  cells[11] = '999';                 // Rotation      — EXCLUDED
  cells[21] = '999'; cells[24] = '999'; // overtime    — EXCLUDED
  cells[26] = '999';                 // Night Shift   — EXCLUDED
  assert.equal(await exact.dailyRateBase(session, cells), 800, 'only the fixed-pay components contribute');
});

// Name-keyed guard: excludes/includes resolve BY NAME via the contract, so a
// column changing position can never silently move money.
test('EX-2 base is name-keyed — excluded columns never enter it; Fixed Overtime + Transport do', async () => {
  const rows = (await db.withOwner((c) => c.query(
    `SELECT header, position FROM exact_column WHERE version='v1.2'`))).rows;
  const pos = Object.fromEntries(rows.map((row) => [row.header, Number(row.position)]));
  // the confirmed real-export anchors
  assert.equal(pos['ROTATION'], 11);
  assert.equal(pos['FIXED OVERTIME'], 19);
  assert.equal(pos['TRANSPORT'], 20);
  assert.equal(pos['OVERTIME NORMAL'], 21);
  assert.equal(pos['OVERTIME HOLIDAY'], 24);
  assert.equal(pos['NIGHT SHIFT'], 26);

  const onlyExcluded = Array(N).fill('0');
  for (const p of [11, 21, 24, 26]) onlyExcluded[p] = '1000';
  assert.equal(await exact.dailyRateBase(session, onlyExcluded), 0, 'excluded-by-name columns never enter the base');

  const onlyFixedOtTransport = Array(N).fill('0');
  onlyFixedOtTransport[19] = '100'; onlyFixedOtTransport[20] = '100';
  assert.equal(await exact.dailyRateBase(session, onlyFixedOtTransport), 200, 'Fixed Overtime + Transport are included by name');
});

// ── Remaining [TBC]: full-period reconciliation still BLOCKS ─────────────────
test('full-period reconciliation (AC-EXACT-07) is still gated', async () => {
  const staged = await exact.stage(session, { period: '2026-06-rec', grid: validGrid([dataRow('E-A-0001', 'Alice')]) });
  await assert.rejects(exact.reconcile(session, staged.batch_id), /pending governance/);
});
