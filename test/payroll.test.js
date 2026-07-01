'use strict';
// Slice — Payroll PC-1/PC-2/PC-3 registry-gating. Proves the daily-rate divisor
// comes from the registry (PC-1 = 30, no 31 anywhere), that PC-3 gross components
// must equal PC-1's fixed-allowance set, and that the [TBC] PC-2 rule BLOCKS.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const payroll = require('../src/payroll');
const { F } = H;

const A = F.TENANT_A;
const setDivisor = (n) => db.withOwner((c) => c.query(
  `UPDATE config SET value=$1 WHERE company_id=$2 AND key='payroll.daily_rate.divisor'`, [String(n), A]));

before(H.start);
after(H.stop);

test('PC-1 daily rate uses the registry divisor (30); nothing computes on 31', async () => {
  // PC-1 = 30.
  assert.equal(await payroll.dailyRate(A, 3000), 100, '3000 / 30');
  // Nothing computes on 31: 3100/30 ≠ 100 (it would be 100 only if divided by 31).
  assert.equal(await payroll.dailyRate(A, 3100), 3100 / 30);
  assert.notEqual(await payroll.dailyRate(A, 3100), 100, 'no 31 divisor');

  // Divisor is read live from the registry (not hard-coded).
  await setDivisor(15);
  try {
    assert.equal(await payroll.dailyRate(A, 3000), 200, '3000 / 15');
  } finally {
    await setDivisor(30); // restore PC-1
  }
});

test('PC-3 gross components must equal PC-1 fixed-allowance set', async () => {
  const gross = await payroll.grossComponents(A);
  const fixed = await payroll.fixedAllowances(A);
  assert.deepEqual([...gross].sort(), [...fixed].sort());
  assert.deepEqual([...gross].sort(), ['house', 'responsibility', 'transport']);
});

test('PC-2 partial-period handling is [TBC] → BLOCKS, does not default', async () => {
  await assert.rejects(payroll.partialPeriodFactor(A), /pending governance/);
});
