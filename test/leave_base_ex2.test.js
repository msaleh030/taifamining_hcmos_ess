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
const INCLUDE_FULL = 'BASIC SALARY,HOUSING ALLOWANCE,RESPONSIBILITY,PROJECT,MEDICAL,HOUSING ALL,FIXED OVERTIME,TRANSPORT';

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
  // Drop TRANSPORT from include WITHOUT excluding it → it is now unclassified.
  await setCfg(INCLUDE, 'BASIC SALARY,HOUSING ALLOWANCE,RESPONSIBILITY,PROJECT,MEDICAL,HOUSING ALL,FIXED OVERTIME');
  const cells = baseCells(); cells[20] = '500'; // TRANSPORT (position 20) carries money — unclassified
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells });
  assert.equal(r.available, false, 'an unclassified non-zero pay column blocks the figure');
  assert.match(r.missing, /TRANSPORT/, 'the reason names the unclassified component');
  // A zero in the same unclassified column does NOT block (no money → nothing to classify).
  await setCfg(RATIFIED, 'true');
  const zero = baseCells(); // TRANSPORT (20) = '0'
  const rz = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells: zero });
  assert.equal(rz.available, true, 'a zero in an unclassified column is not money to classify');
});

test('RATIFIED + fully classified: the figure computes (10 × 3000/30 = 1000) from the one EX-2 base', async () => {
  await setCfg(RATIFIED, 'true');
  await setCfg(INCLUDE, INCLUDE_FULL);
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells: baseCells() });
  assert.equal(r.available, true, JSON.stringify(r));
  assert.equal(r.daily_rate, 100, '3000 / 30');
  assert.equal(r.liability, 1000, '10 × 100');
});
