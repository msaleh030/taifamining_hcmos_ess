'use strict';
// Slice 6 — Leave pay & liability (LIAB-01/02/03). Proves the leave-pay base is
// the SAME EX-2 daily-rate base (one base, no duplicate): daily rate = base /
// PC-1 divisor, leave pay = days × rate, and batch liability sums open leave days
// × rate over matched rows. Overtime and Rotation/Night are excluded from the base.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const liab = require('../src/liability');
const exact = require('../src/exact');
const contractDef = require('../src/exact_contract');
const { F } = H;

const A = F.TENANT_A;
const session = { company_id: A, user_id: F.USERS.PAYMGR_A.id, role_code: 'R09' };
const N = contractDef.build().length;

// EX-2 base sums to 3100 (→ daily rate 3100/31 = 100); overtime + rotation/night
// populated to prove they never reach the base.
function baseCells() {
  const c = Array(N).fill('0');
  c[11] = '3100';               // basic (in the base set 11..18)
  c[19] = '999'; c[20] = '999'; // rotation / night — excluded
  c[21] = '999'; c[24] = '999'; // overtime — excluded
  return c;
}

before(H.start);
after(H.stop);

test('LIAB-01 leave pay = days × (base / PC-1 divisor)', async () => {
  const cells = baseCells();
  assert.equal(await liab.dailyRate(session, cells), 100);     // 3100 / 31
  assert.equal(await liab.leavePay(session, cells, 10), 1000); // 10 days
  assert.equal(await liab.leavePay(session, cells, 0), 0);
});

test('LIAB-03 ONE base: the leave-pay daily rate is derived from exact.dailyRateBase', async () => {
  const cells = baseCells();
  const base = await exact.dailyRateBase(session, cells);       // the single base
  assert.equal(base, 3100, 'overtime + rotation/night are excluded from the base');
  assert.equal(await liab.dailyRate(session, cells), Math.round((base / 31) * 100) / 100);
});

test('LIAB-02 batch liability = Σ (open leave days × daily rate) over matched rows', async () => {
  const cells = baseCells();
  // Isolated fixtures: a matched Exact row + a known open carry for one employee.
  const setup = await db.withOwner(async (c) => {
    const b = (await c.query(
      `INSERT INTO exact_batch(company_id,period,file_hash,version,status,row_count)
       VALUES ($1,'2026-06-liab','liab-hash-1','v1.2','staged',1) RETURNING id`, [A])).rows[0];
    await c.query(
      `INSERT INTO exact_row(company_id,batch_id,row_no,employee_id_raw,full_name,cells,matched_employee,match_status)
       VALUES ($1,$2,1,'E-A-0051','Dan Subject',$3,$4,'matched')`,
      [A, b.id, JSON.stringify(cells), F.EMP.DSUBJ]);
    const lc = (await c.query(
      `INSERT INTO leave_carry(company_id,employee_id,days,carried_for_year)
       VALUES ($1,$2,10,2026) RETURNING id`, [A, F.EMP.DSUBJ])).rows[0];
    return { batchId: b.id, carryId: lc.id };
  });
  try {
    const res = await liab.batchLiability(session, setup.batchId);
    assert.equal(res.employees.length, 1);
    assert.equal(res.employees[0].days, 10);
    assert.equal(res.employees[0].daily_rate, 100);
    assert.equal(res.total, 1000);
  } finally {
    await db.withOwner(async (c) => {
      await c.query('DELETE FROM leave_carry WHERE id=$1', [setup.carryId]);
      await c.query('DELETE FROM exact_batch WHERE id=$1', [setup.batchId]); // cascades exact_row
    });
  }
});
