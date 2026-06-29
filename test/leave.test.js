'use strict';
// Slice — Leave LR-4: carry-forward lapse nightly job. Proves the lapse window
// comes from the registry (LOCKED 1 year, CHANGED from 2): with a 2026 "as of",
// a 2024 carry lapses and a 2025 carry survives — and the threshold is NOT a
// literal (setting it to 2 retains the 2024 carry).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const leave = require('../src/leave');
const { F } = H;

const A = F.TENANT_A;
const AS_OF = '2026-06-29';
const setLapseYears = (n) => db.withOwner((c) => c.query(
  `UPDATE config SET value=$1 WHERE company_id=$2 AND key='leave.carry.lapse_years'`, [String(n), A]));
const openCarry = () => db.withOwner((c) => c.query(
  `SELECT carried_for_year, lapsed_at FROM leave_carry WHERE company_id=$1 ORDER BY carried_for_year`, [A]));

before(H.start);
after(H.stop);

test('LR-4 nightly job lapses carry past one year; keeps carry inside the window', async () => {
  const res = await leave.lapseCarry(A, AS_OF);
  assert.equal(res.lapse_years, 1, 'window read from the registry (LOCKED 1)');

  const lapsedYears = res.lapsed.map((r) => r.carried_for_year);
  assert.deepEqual(lapsedYears, [2024], 'only the 2024 carry lapsed');

  const rows = (await openCarry()).rows;
  const y2024 = rows.find((r) => r.carried_for_year === 2024);
  const y2025 = rows.find((r) => r.carried_for_year === 2025);
  assert.ok(y2024.lapsed_at !== null, '2024 carry is lapsed');
  assert.equal(y2025.lapsed_at, null, '2025 carry survives (still inside the window)');

  // It is audited on the hash chain.
  const audited = await db.withOwner((c) => c.query(
    `SELECT count(*)::int n FROM audit WHERE company_id=$1 AND action='leave.carry.lapse'`, [A]));
  assert.ok(audited.rows[0].n >= 1, 'lapse is on the audit chain');
});

test('LR-4 lapse window is registry-driven, not a literal (set 2 → 2024 retained)', async () => {
  // Re-open the 2024 carry, widen the window to the OLD value, and re-run.
  await db.withOwner((c) => c.query(
    `UPDATE leave_carry SET lapsed_at=NULL WHERE company_id=$1 AND carried_for_year=2024`, [A]));
  await setLapseYears(2);
  try {
    const res = await leave.lapseCarry(A, AS_OF);
    assert.equal(res.lapse_years, 2);
    assert.ok(!res.lapsed.some((r) => r.carried_for_year === 2024),
      'with a 2-year window the 2024 carry does NOT lapse — proves the value drives it');
  } finally {
    await setLapseYears(1); // restore the locked value
    await db.withOwner((c) => c.query(
      `UPDATE leave_carry SET lapsed_at=now() WHERE company_id=$1 AND carried_for_year=2024`, [A]));
  }
});
