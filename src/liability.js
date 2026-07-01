'use strict';
// Slice 6 — Leave pay & liability (LIAB-01/02/03, LVR-02).
//
// ONE base: the leave-pay base IS the EX-2 daily-rate base (exact.dailyRateBase);
// no second base is created. Per v1.4:
//   daily rate = monthly remuneration (that base) / 30
//   liability  = outstanding leave days × daily rate
//   scope      = ACTIVE staff only (leavers excluded — LVR-02)
//   missing input → NOT-AVAILABLE naming the input, never silently zero (LIAB-03)
const db = require('./db');
const cfg = require('./config');
const exact = require('./exact');

const round2 = (x) => Math.round(x * 100) / 100;
const REMUNERATION = 'monthly remuneration';

// The single daily rate — the one EX-2 base divided by the leave divisor (30).
async function dailyRate(session, cells) {
  const base = await exact.dailyRateBase(session, cells);                    // ONE base
  const divisor = await cfg.getRequiredInt(session.company_id, 'leave.liability.divisor'); // 30
  return round2(base / divisor);
}

// LIAB-01/03: liability for one employee = outstanding days × daily rate.
// Returns not-available (naming the missing input) instead of zero when the
// monthly remuneration input is absent.
async function liabilityFor(session, { employeeId, days, cells }) {
  if (cells == null) return { employee_id: employeeId, available: false, missing: REMUNERATION };
  const base = await exact.dailyRateBase(session, cells);
  if (!(base > 0)) return { employee_id: employeeId, available: false, missing: REMUNERATION };
  const rate = await dailyRate(session, cells);
  return { employee_id: employeeId, available: true, days, daily_rate: rate, liability: round2(rate * days) };
}

// LIAB-01: leave pay for a number of leave days.
async function leavePay(session, cells, days) {
  const res = await liabilityFor(session, { days: Number(days || 0), cells });
  return res.available ? res.liability : res;
}

// Outstanding (non-lapsed) carry days for an employee.
async function openLeaveDays(client, employeeId) {
  const r = await client.query(
    'SELECT coalesce(sum(days),0)::float8 AS d FROM leave_carry WHERE employee_id=$1 AND lapsed_at IS NULL',
    [employeeId]);
  return Number(r.rows[0].d);
}

// LIAB-02 / LVR-02: total leave liability across ACTIVE staff only. Each active
// employee's remuneration comes from their matched Exact row. Leavers (non-active)
// are excluded; an active employee with no remuneration is reported not-available
// (input named), never counted as zero.
async function batchLiability(session, batchId) {
  return db.withTenant(session.company_id, async (c) => {
    const rows = (await c.query(
      `SELECT r.matched_employee AS employee_id, r.cells, e.status
         FROM exact_row r JOIN employee e ON e.id = r.matched_employee
        WHERE r.batch_id=$1 AND r.match_status='matched'
        ORDER BY r.row_no`, [batchId])).rows;

    const available = [], not_available = [], excluded = [];
    let total = 0;
    for (const row of rows) {
      if (row.status !== 'active') { excluded.push({ employee_id: row.employee_id, status: row.status }); continue; } // LVR-02
      const days = await openLeaveDays(c, row.employee_id);
      const res = await liabilityFor(session, { employeeId: row.employee_id, days, cells: row.cells });
      if (res.available) { available.push(res); total = round2(total + res.liability); }
      else not_available.push(res);
    }
    return { batch_id: batchId, total, available, not_available, excluded };
  });
}

module.exports = { dailyRate, liabilityFor, leavePay, openLeaveDays, batchLiability };
