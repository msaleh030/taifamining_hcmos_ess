'use strict';
// EX-2 / LIAB-03 governance gate (Kira 2026-07-14). The leave-pay/liability
// figure must NEVER be a silent, possibly-wrong number:
//   1. FAIL-CLOSED — while the pay-component classification is not RATIFIED
//      (exact.dailyrate.classification.ratified ≠ 'true') the figure is NOT
//      AVAILABLE, naming the pending ratification.
//   2. UNCLASSIFIED — even once ratified, an allowance column that carries money
//      but is neither included nor excluded from the base is NOT AVAILABLE,
//      NAMING the component (Cecilia must classify it). On North Mara this catches
//      the un-named allowance columns that Rotation/Night-shift/overtime do not.
//   3. Only when ratified AND every populated pay column is classified does the
//      base compute — the same one base ÷30 the certified LIAB-01 math pins.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const liab = require('../src/liability');
const contractDef = require('../src/exact_contract');
const { F } = H;

const A = F.TENANT_A;
const N = contractDef.build().length;
const session = { company_id: A, user_id: F.USERS.FINMGR_A.id, role_code: 'R15' };
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const setCfg = (k, v) => owner(
  `INSERT INTO config(company_id,key,value) VALUES ($1,$2,$3)
   ON CONFLICT (company_id,key) DO UPDATE SET value=EXCLUDED.value`, [A, k, v]);
const RATIFIED = 'exact.dailyrate.classification.ratified';
const INCLUDE = 'exact.dailyrate.include_names';
// RATIFIED six (Kira 2026-07-14, official NM export — exact strings).
const INCLUDE_FULL = 'Basic Salary,Fixed Overtime,Project Allowance,Responsibility Allowance,Housing Allowance (Fixed),Transport Allowance(Fixed)';

function baseCells() { const c = Array(N).fill('0'); c[12] = '3000'; return c; } // BASIC SALARY only (classified)

before(H.start);
after(async () => { await setCfg(RATIFIED, '__TBC__'); await setCfg(INCLUDE, INCLUDE_FULL); await H.stop(); });

test('FAIL-CLOSED: while the EX-2 classification is not ratified, the figure is NOT AVAILABLE (named), never a number', async () => {
  await setCfg(INCLUDE, INCLUDE_FULL);
  await setCfg(RATIFIED, '__TBC__');
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells: baseCells() });
  assert.equal(r.available, false, 'not available while the classification is unratified');
  assert.match(r.missing, /ratification/i, 'the reason names the pending ratification');
  assert.ok(!('liability' in r), 'never a figure while unratified');
});

test('UNCLASSIFIED: money in a pay column neither included nor excluded → NOT AVAILABLE naming the component', async () => {
  await setCfg(RATIFIED, 'true');
  // Drop Transport Allowance(Fixed) from include WITHOUT excluding it → unclassified.
  await setCfg(INCLUDE, 'Basic Salary,Fixed Overtime,Project Allowance,Responsibility Allowance,Housing Allowance (Fixed)');
  const cells = baseCells(); cells[20] = '500'; // Transport Allowance(Fixed) (position 20) carries money — unclassified
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells });
  assert.equal(r.available, false, 'an unclassified non-zero pay column blocks the figure');
  assert.match(r.missing, /Transport Allowance\(Fixed\)/, 'the reason names the unclassified component');
  // A zero in the same unclassified column does NOT block (no money → nothing to classify).
  await setCfg(RATIFIED, 'true');
  const zero = baseCells(); // Transport Allowance(Fixed) (20) = '0'
  const rz = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells: zero });
  assert.equal(rz.available, true, 'a zero in an unclassified column is not money to classify');
});

test('PENDING CECILIA: money in a pending-named component blocks the figure NAMING the governance hold', async () => {
  await setCfg(RATIFIED, 'true');
  await setCfg(INCLUDE, INCLUDE_FULL);
  // Position 16 is the un-named slot (ex-MEDICAL phantom). Point pending_names at
  // its header to pin the MECHANISM; in production the pending names are
  // 'Local Conveyance,TSF Allowance' (Kira 2026-07-14 — do not guess).
  await setCfg('exact.dailyrate.pending_names', 'ALLOWANCES 16');
  try {
    const cells = baseCells(); cells[16] = '25000'; // pending component carries money
    const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells });
    assert.equal(r.available, false, 'a pending component with money blocks the figure');
    assert.match(r.missing, /pending Cecilia/, 'the reason names the governance hold');
    assert.match(r.missing, /ALLOWANCES 16/, 'and the component');
  } finally {
    await setCfg('exact.dailyrate.pending_names', 'Local Conveyance,TSF Allowance');
  }
});

test('GROSS-TRAP sanity: the base is the SIX ratified components, never gross — variable money never enters', async () => {
  await setCfg(RATIFIED, 'true');
  await setCfg(INCLUDE, INCLUDE_FULL);
  // A row where gross-style thinking is 33% wrong: base components 3000, plus
  // variable/excluded money (rotation 500, variable house 300, OT 200) = gross 4000.
  const cells = baseCells();          // Basic Salary (12) = 3000
  cells[11] = '500';                  // Rotation Allowance — EXCLUDED
  cells[17] = '300';                  // House Allowance(Variable) — EXCLUDED
  cells[21] = '200';                  // Overtime - Normal Days — EXCLUDED
  const exact = require('../src/exact');
  const base = await exact.dailyRateBase(session, cells);
  assert.equal(base, 3000, 'base = the six ratified components only');
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells });
  assert.equal(r.available, true, JSON.stringify(r));
  assert.equal(r.daily_rate, 100, 'daily = base/30 (3000/30), NOT gross/30 (4000/30≈133) — the 33% gross trap');
});

test('RATIFIED + fully classified: the figure computes (10 × 3000/30 = 1000) from the one EX-2 base', async () => {
  await setCfg(RATIFIED, 'true');
  await setCfg(INCLUDE, INCLUDE_FULL);
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells: baseCells() });
  assert.equal(r.available, true, JSON.stringify(r));
  assert.equal(r.daily_rate, 100, '3000 / 30');
  assert.equal(r.liability, 1000, '10 × 100');
});
