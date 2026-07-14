'use strict';
// Slice 6 — Leave pay & liability (LIAB-01/02/03, LVR-02).
//
// ONE base: the leave-pay base IS the EX-2 daily-rate base (exact.dailyRateBase);
// no second base is created. Per v1.4 (the numbers here are pinned by
// test/liability.test.js + test/f3.test.js, not by this comment):
//   daily rate = monthly remuneration (that base) / 30
//   liability  = outstanding leave days × daily rate
//   scope      = ACTIVE staff only (leavers excluded — LVR-02)
//   missing input → NOT-AVAILABLE naming the input, never silently zero (LIAB-03)
const db = require('./db');
const cfg = require('./config');
const exact = require('./exact');

const round2 = (x) => Math.round(x * 100) / 100;
const REMUNERATION = 'monthly remuneration';

// Wave 7 — a FINANCIAL REGISTER disclosure leaves an audit trail: who read which
// register of which batch. Wave 5 audited confidential PROFILE reads at the
// a3.assembleProfile boundary, but the money registers (payroll, leave-
// liability, terminal) bypass that path — so they were invisible. Forward-only
// via audit_append (the hash chain extends by construction). Shared so the
// payroll and terminal registers log the same way.
async function auditRegisterRead(session, register, batchId, lineCount) {
  await db.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
    session.company_id, String(session.user_id || session.device_id || 'system'), session.role_code,
    'register.read', 'exact_batch', String(batchId), null, { register, lines: lineCount }]);
}

// The single daily rate — the one EX-2 base divided by the PC-1 divisor. Leave
// pay uses the SAME PC-1 basis as payroll; there is no separate divisor. The
// divisor value (30) is pinned by test/liability.test.js (LIAB-01: base 3000 →
// dailyRate 100), not by this comment.
async function dailyRate(session, cells) {
  const base = await exact.dailyRateBase(session, cells);                       // ONE base
  // bughunt-B #9: a zero/negative/garbage divisor must 409, never divide.
  const divisor = await cfg.getRequiredPositiveInt(session.company_id, 'payroll.daily_rate.divisor');
  return round2(base / divisor);
}

// LIAB-01/03: liability for one employee = outstanding days × daily rate.
// Returns not-available (naming the missing input) instead of zero when the
// monthly remuneration input is absent.
async function liabilityFor(session, { employeeId, days, cells }) {
  if (cells == null) return { employee_id: employeeId, available: false, missing: REMUNERATION };
  const base = await exact.dailyRateBase(session, cells);
  if (!(base > 0)) return { employee_id: employeeId, available: false, missing: REMUNERATION };
  // EX-2 / LIAB-03 (Kira 2026-07-14): never disclose a figure while the pay-
  // component classification is unratified or a component carries unclassified
  // money — NOT AVAILABLE naming the reason, never a silent (possibly wrong) zero.
  const unavailable = await exact.baseUnavailableReason(session, cells);
  if (unavailable) return { employee_id: employeeId, available: false, missing: unavailable };
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
    // FLOAT DETERMINISM (Kira 2026-07-14): the register total accumulates in
    // INTEGER CENTS (each per-person liability is already a 2-dp figure) and
    // divides back to shillings ONCE at the end — exact integer math, so the
    // CEO's number cannot move by a shilling with row order.
    let totalCents = 0;
    // bughunt-B #6: an employee matched by MORE THAN ONE Exact row counts ONCE —
    // openLeaveDays() returns their WHOLE outstanding balance, so each duplicate
    // row would re-add the full liability to the register.
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.employee_id)) { excluded.push({ employee_id: row.employee_id, status: 'duplicate-row' }); continue; }
      seen.add(row.employee_id);
      if (row.status !== 'active') { excluded.push({ employee_id: row.employee_id, status: row.status }); continue; } // LVR-02
      const days = await openLeaveDays(c, row.employee_id);
      const res = await liabilityFor(session, { employeeId: row.employee_id, days, cells: row.cells });
      if (res.available) { available.push(res); totalCents += Math.round(res.liability * 100); }
      else not_available.push(res);
    }
    return { batch_id: batchId, total: totalCents / 100, available, not_available, excluded };
  });
}

// batchLiability with the Wave-7 register-read audit. Both callers of the
// leave-liability figures (GET /liability/batch/:id and the leave-liability
// register) route through here, so a disclosure is logged exactly once per read.
async function batchLiabilityAudited(session, batchId) {
  const result = await batchLiability(session, batchId);
  await auditRegisterRead(session, 'leave-liability', batchId,
    result.available.length + result.not_available.length);
  return result;
}

module.exports = {
  dailyRate, liabilityFor, leavePay, openLeaveDays,
  batchLiability: batchLiabilityAudited, batchLiabilityRaw: batchLiability, auditRegisterRead,
};
