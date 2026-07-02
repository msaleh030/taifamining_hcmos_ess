'use strict';
// Slice 6 — Leave pay & liability (LIAB-01/02/03, LVR-02, registry v1.4).
// ONE base: leave-pay base == EX-2 daily-rate base (exact.dailyRateBase).
//   daily rate = monthly remuneration / 30; liability = outstanding days × rate;
//   ACTIVE staff only (leavers excluded); missing input → not-available (named),
//   never zero.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const liab = require('../src/liability');
const exact = require('../src/exact');
const contractDef = require('../src/exact_contract');
const { F } = H;

const A = F.TENANT_A;
const session = { company_id: A, user_id: F.USERS.FINMGR_A.id, role_code: 'R15' };
const N = contractDef.build().length;

// EX-2 base sums to 3000 (→ daily rate 3000/30 = 100). Basic sits at col 12
// (an INCLUDED component); Rotation(11)/overtime(21,24)/Night Shift(26) are
// populated to prove they never reach the base.
function baseCells() {
  const c = Array(N).fill('0');
  c[12] = '3000';                       // Basic Salary (included)
  c[11] = '999';                        // Rotation      — excluded
  c[21] = '999'; c[24] = '999';         // overtime      — excluded
  c[26] = '999';                        // Night Shift   — excluded
  return c;
}

before(H.start);
after(H.stop);

test('LIAB-01 liability = outstanding days × (monthly remuneration / 30), from the one EX-2 base', async () => {
  const cells = baseCells();
  assert.equal(await exact.dailyRateBase(session, cells), 3000, 'overtime + rotation/night excluded (one base)');
  assert.equal(await liab.dailyRate(session, cells), 100);         // 3000 / 30
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells });
  assert.equal(r.available, true);
  assert.equal(r.daily_rate, 100);
  assert.equal(r.liability, 1000);                                 // 10 × 100
});

test('LIAB-03 missing input → not-available (input named), never zero', async () => {
  const na = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells: Array(N).fill('0') });
  assert.equal(na.available, false);
  assert.equal(na.missing, 'monthly remuneration');
  assert.ok(!('liability' in na), 'not-available, never a zero liability');
});

test('LIAB-02 / LVR-02 batch liability covers ACTIVE staff only; leavers excluded; missing named', async () => {
  const cells = baseCells();
  const setup = await db.withOwner(async (c) => {
    const b = (await c.query(
      `INSERT INTO exact_batch(company_id,period,file_hash,version,status,row_count)
       VALUES ($1,'2026-06-liab','liab-hash-2','v1.2','staged',3) RETURNING id`, [A])).rows[0];
    const row = (empId, emp, cellArr, no) => c.query(
      `INSERT INTO exact_row(company_id,batch_id,row_no,employee_id_raw,full_name,cells,matched_employee,match_status)
       VALUES ($1,$2,$3,$4,'',$5,$6,'matched')`, [A, b.id, no, empId, JSON.stringify(cellArr), emp]);
    await row('E-A-0005', F.EMP.DAVE, cells, 1);              // active → counted
    await row('E-A-0004', F.EMP.TERM, cells, 2);              // terminated (leaver) → excluded
    await row('E-A-0002', F.EMP.CAROL, Array(N).fill('0'), 3); // active but no remuneration → not-available
    const c1 = (await c.query(`INSERT INTO leave_carry(company_id,employee_id,days,carried_for_year) VALUES ($1,$2,10,2026) RETURNING id`, [A, F.EMP.DAVE])).rows[0];
    const c2 = (await c.query(`INSERT INTO leave_carry(company_id,employee_id,days,carried_for_year) VALUES ($1,$2,7,2026) RETURNING id`, [A, F.EMP.TERM])).rows[0];
    return { batchId: b.id, carryIds: [c1.id, c2.id] };
  });
  try {
    const res = await liab.batchLiability(session, setup.batchId);
    assert.equal(res.total, 1000, 'only the active employee with remuneration contributes');
    assert.deepEqual(res.available.map((a) => a.employee_id), [F.EMP.DAVE]);
    assert.deepEqual(res.excluded.map((e) => e.employee_id), [F.EMP.TERM]);      // LVR-02
    assert.deepEqual(res.not_available.map((n) => n.employee_id), [F.EMP.CAROL]);
    assert.equal(res.not_available[0].missing, 'monthly remuneration');
  } finally {
    await db.withOwner(async (c) => {
      for (const id of setup.carryIds) await c.query('DELETE FROM leave_carry WHERE id=$1', [id]);
      await c.query('DELETE FROM exact_batch WHERE id=$1', [setup.batchId]); // cascades exact_row
    });
  }
});
