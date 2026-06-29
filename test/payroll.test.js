'use strict';
// Slice — Payroll PC-1/PC-2/PC-3 registry-gating. Proves the daily-rate divisor
// comes from the registry (not the literal 31), that PC-3 gross components must
// equal PC-1's fixed-allowance set, and that the [TBC] PC-2 rule BLOCKS.
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

test('PC-1 daily rate uses the divisor from the registry, not a literal 31', async () => {
  // LOCKED divisor = 31.
  assert.equal(await payroll.dailyRate(A, 3100), 100, '3100 / 31');

  // Change the registry → the computation changes (so it is not hard-coded 31).
  await setDivisor(30);
  try {
    assert.equal(await payroll.dailyRate(A, 3000), 100, 'now 3000 / 30');
    assert.equal(await payroll.dailyRate(A, 3100), 3100 / 30, 'divisor is read live from config');
    assert.notEqual(await payroll.dailyRate(A, 3100), 100, 'not the literal 31 divisor');
  } finally {
    await setDivisor(31); // restore the locked (flagged) value
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
