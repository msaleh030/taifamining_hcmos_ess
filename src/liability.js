'use strict';
// Slice 6 — Leave pay & liability (LIAB-01/02/03).
//
// ONE base: the leave-pay base IS the EX-2 daily-rate base (exact.dailyRateBase).
// There is no second base — this module composes onto the existing engines:
//   daily rate = exact.dailyRateBase(row)  ÷  PC-1 divisor (payroll.dailyRate)
//   leave pay  = leave days × daily rate
//   liability  = Σ over matched employees of (open leave days × daily rate)
const db = require('./db');
const exact = require('./exact');
const payroll = require('./payroll');

const round2 = (x) => Math.round(x * 100) / 100;

// LIAB-03: the single daily rate — EX-2 base (excl overtime + rotation/night)
// divided by the PC-1 divisor. Both inputs come from the shared engines.
async function dailyRate(session, cells) {
  const base = await exact.dailyRateBase(session, cells);         // the one base
  return round2(await payroll.dailyRate(session.company_id, base)); // base / PC-1 divisor
}

// LIAB-01: leave pay for a number of leave days.
async function leavePay(session, cells, days) {
  return round2((await dailyRate(session, cells)) * Number(days || 0));
}

// Outstanding (non-lapsed) carry days for an employee.
async function openLeaveDays(client, employeeId) {
  const r = await client.query(
    'SELECT coalesce(sum(days),0)::float8 AS d FROM leave_carry WHERE employee_id=$1 AND lapsed_at IS NULL',
    [employeeId]);
  return Number(r.rows[0].d);
}

// LIAB-02: total leave liability across a matched Exact batch. Each employee's
// daily rate is derived from THEIR matched Exact row — the same one base.
async function batchLiability(session, batchId) {
  return db.withTenant(session.company_id, async (c) => {
    const rows = (await c.query(
      `SELECT matched_employee, cells FROM exact_row
        WHERE batch_id=$1 AND match_status='matched' AND matched_employee IS NOT NULL
        ORDER BY row_no`, [batchId])).rows;
    const employees = [];
    let total = 0;
    for (const r of rows) {
      const days = await openLeaveDays(c, r.matched_employee);
      const rate = await dailyRate(session, r.cells);
      const liability = round2(rate * days);
      employees.push({ employee_id: r.matched_employee, days, daily_rate: rate, liability });
      total = round2(total + liability);
    }
    return { batch_id: batchId, total, employees };
  });
}

module.exports = { dailyRate, leavePay, openLeaveDays, batchLiability };
