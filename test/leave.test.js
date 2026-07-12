'use strict';
// v1.5 LR-4/LR-8/LR-9 — the GOING-FORWARD carry rule (replaces the flat one-year
// lapse). CR-1 cap at 10 at the employment anniversary; CR-2 forfeit unused at
// anniversary + 3 months (used days survive); CR-3 opening bucket exempt;
// CR-4 idempotent (daily re-runs forfeit nothing more); CR-5 every forfeiture
// on the audit chain. The 10-day cap and 3-month grace are POLICY VALUES pinned
// here — do not change without Kira.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const leave = require('../src/leave');
const { DEFAULT_CONFIG } = require('../src/config');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const setCfg = (k, v) => owner(`UPDATE config SET value=$1 WHERE company_id=$2 AND key=$3`, [v, A, k]);

async function mkEmployee(name, joined) {
  return (await owner(
    `INSERT INTO employee(company_id, site_id, full_name, role_code, status, joined_at)
     VALUES ($1,$2,$3,'R01','active',$4) RETURNING id`, [A, F.SITE.A1, name, joined])).rows[0].id;
}
const addCarry = (emp, days, year, opening = false) => owner(
  `INSERT INTO leave_carry(company_id, employee_id, days, carried_for_year, opening_bucket)
   VALUES ($1,$2,$3,$4,$5)`, [A, emp, days, year, opening]);
const openSum = async (emp, opening = false) => Number((await owner(
  `SELECT coalesce(sum(days),0)::float8 d FROM leave_carry
    WHERE employee_id=$1 AND lapsed_at IS NULL AND opening_bucket=$2`, [emp, opening])).rows[0].d);
async function purge(emp) {
  await owner(`DELETE FROM leave_carry_sweep WHERE employee_id=$1`, [emp]);
  await owner(`DELETE FROM leave_request WHERE employee_id=$1`, [emp]);
  await owner(`DELETE FROM leave_carry WHERE employee_id=$1`, [emp]);
  await owner(`DELETE FROM employee WHERE id=$1`, [emp]);
}

before(H.start);
after(H.stop);

// Policy values: pinned as registry values, not literals.
test('carry policy values are in the registry: cap 10 days, grace 3 months (do not change without Kira)', () => {
  assert.equal(DEFAULT_CONFIG['leave.carry.cap_days'], '10');
  assert.equal(DEFAULT_CONFIG['leave.carry.grace_months'], '3');
  assert.ok(!('leave.carry.lapse_years' in DEFAULT_CONFIG), 'the flat one-year lapse is GONE (replaced)');
});

// ── Negative opening balance (Omid ruling): persists + nets, never clamped ───
test('a negative opening balance persists and NETS against entitlement (not clamped to 0)', async () => {
  const emp = await mkEmployee('Juliana Deficit', '2020-01-10');
  const uid = (await owner(
    `INSERT INTO app_user(id, company_id, employee_id, email, password_hash, mfa_secret, role_code, status)
     VALUES (gen_random_uuid(),$1,$2,'juliana.deficit@a.example','x','x','R01','active') RETURNING id`, [A, emp])).rows[0].id;
  const sess = { company_id: A, user_id: uid, role_code: 'R01' };
  try {
    const entitlement = Number(DEFAULT_CONFIG['leave.entitlement.default'] || 21);
    // The opening bucket CHECK now allows a negative deficit.
    await addCarry(emp, -5, 2025, true);
    assert.equal(await openSum(emp, true), -5, 'negative opening balance persists (was CHECK-rejected before)');
    const bal = await leave.balance(sess);
    assert.equal(bal.annual.carried, -5, 'carried reflects the deficit');
    assert.equal(bal.annual.available, entitlement - 5, 'available NETS the deficit against entitlement — not clamped to 0');
    assert.ok(bal.annual.available < entitlement, 'the deficit reduces available leave');

    // Guard: a negative on a NORMAL (non-opening) carry row is still rejected —
    // the FIFO forfeiture/cap sweep assumes non-negative balances.
    await assert.rejects(addCarry(emp, -3, 2025, false), /leave_carry_days_check|violates check/,
      'negative is allowed ONLY for the protected opening bucket');
  } finally {
    await owner(`DELETE FROM app_user WHERE id=$1`, [uid]);
    await purge(emp);
  }
});

// ── CR-6 (bughunt-B #1/#2): entitlement renews per cycle; NO double charge ───
// The double charge: a leave taken BEFORE the anniversary was (a) subtracted
// from the balance (lifetime sum) AND (b) not credited against forfeiture (the
// sweep counts only post-anniversary use) — charged twice. With consumption
// cycle-scoped, balance() and the sweep share ONE window. B's repro: 21 vs 16.
test('CR-6 entitlement renews per cycle; prior-cycle leave is never double-charged at forfeit (21, not 16)', async () => {
  // Joined 2020-06-01 → anniversary 2026-06-01; grace end 2026-09-01.
  const emp = await mkEmployee('Carry NoDouble', '2020-06-01');
  const uid = (await owner(
    `INSERT INTO app_user(id, company_id, employee_id, email, password_hash, mfa_secret, role_code, status)
     VALUES (gen_random_uuid(),$1,$2,'cr6.nodouble@a.example','x','x','R01','active') RETURNING id`, [A, emp])).rows[0].id;
  const sess = { company_id: A, user_id: uid, role_code: 'R01' };
  try {
    await addCarry(emp, 10, 2025);
    // 5 days taken in the PRIOR cycle (before the 2026-06-01 anniversary).
    await owner(`INSERT INTO leave_request(company_id, employee_id, leave_type, days, status, applied_at)
                 VALUES ($1,$2,'annual',5,'applied','2026-05-01T00:00:00Z')`, [A, emp]);

    const before = await leave.balance(sess);
    assert.equal(before.annual.taken, 0, '#1 renews: the prior-cycle 5 days are not in this cycle\'s consumption');
    assert.equal(before.annual.available, 31, '21 entitlement + 10 carry — prior-cycle use not deducted');

    // Grace end passes with the carry unused THIS cycle → all 10 forfeited.
    await leave.carrySweep(A, '2026-09-05');
    const after = await leave.balance(sess);
    assert.equal(after.annual.carried, 0, 'unused carry fully forfeited at anniversary+3mo');
    assert.equal(after.annual.available, 21,
      '#2 NO DOUBLE CHARGE: forfeiting the carry must not ALSO deduct the prior-cycle 5 (the bug landed at 16)');
  } finally {
    await owner(`DELETE FROM app_user WHERE id=$1`, [uid]);
    await purge(emp);
  }
});

// ── CR-1..CR-5 through a full anniversary cycle ──────────────────────────────
test('CR-1..CR-5: cap at anniversary, forfeit unused at +3mo, opening exempt, idempotent, audited', async () => {
  // Joined 2020-01-10 → anniversary (cycle 2026) = 2026-01-10; grace end 2026-04-10.
  const emp = await mkEmployee('Carry Cycle One', '2020-01-10');
  try {
    await addCarry(emp, 9, 2024);          // oldest — FIFO forfeits from here first
    await addCarry(emp, 6, 2025);
    await addCarry(emp, 20, 2025, true);   // OPENING bucket — must never be touched

    // CR-1: at the anniversary the 15 carried days are capped at 10 (excess 5 forfeited).
    const r1 = await leave.carrySweep(A, '2026-01-15');
    const capped = r1.processed.find((p) => p.employee_id === emp && p.phase === 'cap');
    assert.equal(capped.forfeited, 5, 'CR-1: excess over the 10-day cap forfeited at the anniversary');
    assert.equal(await openSum(emp), 10);
    const rows = (await owner(`SELECT days, carried_for_year, lapsed_at FROM leave_carry
      WHERE employee_id=$1 AND opening_bucket=false ORDER BY carried_for_year`, [emp])).rows;
    assert.equal(Number(rows[0].days), 4, 'FIFO: the oldest carry absorbed the forfeiture (9→4)');
    assert.equal(Number(rows[1].days), 6, 'newer carry untouched by the cap');

    // CR-4 (a): a daily re-run before the grace end forfeits nothing more.
    const r2 = await leave.carrySweep(A, '2026-01-20');
    assert.ok(!r2.processed.some((p) => p.employee_id === emp), 'idempotent: cap not re-applied');
    assert.equal(await openSum(emp), 10);

    // The employee USES 4 days after the anniversary (they survive — never clawed back).
    await owner(`INSERT INTO leave_request(company_id, employee_id, leave_type, days, status, applied_at)
                 VALUES ($1,$2,'annual',4,'applied','2026-02-01T00:00:00Z')`, [A, emp]);

    // CR-2: at anniversary + 3 months, only the UNUSED 6 of the 10 are forfeited.
    const r3 = await leave.carrySweep(A, '2026-04-15');
    const forf = r3.processed.find((p) => p.employee_id === emp && p.phase === 'forfeit');
    assert.equal(forf.forfeited, 6, 'CR-2: unused carry forfeited; the 4 used days survive');
    assert.equal(await openSum(emp), 4, 'remaining carry equals the days consumed by leave taken');

    // CR-4 (b): running the sweep again forfeits nothing more.
    const r4 = await leave.carrySweep(A, '2026-04-20');
    assert.ok(!r4.processed.some((p) => p.employee_id === emp), 'idempotent: forfeit not re-applied');
    assert.equal(await openSum(emp), 4);

    // CR-3: the opening bucket is untouched through BOTH phases.
    assert.equal(await openSum(emp, true), 20, 'CR-3: opening bucket exempt — never capped, never forfeited');
    const ob = (await owner(`SELECT lapsed_at FROM leave_carry WHERE employee_id=$1 AND opening_bucket=true`, [emp])).rows[0];
    assert.equal(ob.lapsed_at, null);

    // CR-5: each forfeiture is on the audit chain with employee, days and reason.
    const aud = (await owner(
      `SELECT action, after FROM audit WHERE company_id=$1 AND entity_id=$2 AND action LIKE 'leave.carry.%' ORDER BY seq`,
      [A, emp])).rows;
    const cap = aud.find((a) => a.action === 'leave.carry.cap');
    const forfeit = aud.find((a) => a.action === 'leave.carry.forfeit');
    assert.equal(cap.after.forfeited, 5);
    assert.match(cap.after.reason, /capped at 10d at anniversary 2026-01-10/);
    assert.equal(forfeit.after.forfeited, 6);
    assert.match(forfeit.after.reason, /anniversary\+3mo \(2026-04-10\)/);
  } finally {
    await purge(emp);
  }
});

// ── The cap is registry-driven, not a literal ────────────────────────────────
test('the cap comes from the registry (set 12 → only 3 of 15 forfeited), not a hard-coded 10', async () => {
  const emp = await mkEmployee('Carry Cycle Two', '2021-03-05');
  await setCfg('leave.carry.cap_days', '12');
  try {
    await addCarry(emp, 15, 2025);
    const r = await leave.carrySweep(A, '2026-03-10'); // anniversary 2026-03-05
    const capped = r.processed.find((p) => p.employee_id === emp && p.phase === 'cap');
    assert.equal(capped.forfeited, 3, 'with cap 12, 15 → forfeit 3 (the value drives it)');
    assert.equal(await openSum(emp), 12);
  } finally {
    await setCfg('leave.carry.cap_days', '10'); // restore the policy value
    await purge(emp);
  }
});
