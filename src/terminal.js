'use strict';
// Wave 7 — Terminal / severance dues (TD-1).
//
// The STATUTORY days-of-basic-wage per COMPLETED year of service is a governance
// value (config terminal.severance.days_per_year), REQUIRED and PENDING by
// default → every computation BLOCKS with 409 until it is confirmed. A severance
// figure is never guessed. Structure only lives here:
//   daily basic = the ONE PC-1 base (exact.dailyRateBase) / the PC-1 divisor
//   severance   = daily basic × days_per_year × COMPLETED years of service
//   service     = whole years between employee.joined_at and asOf
//   qualify     = completed years >= terminal.min_service_years, else 0
//   missing base / joining date → NOT-AVAILABLE naming the input, never a silent 0
//   scope       = ACTIVE staff only; leavers and duplicate rows excluded
//     (mirrors liability.batchLiability exactly).
const db = require('./db');
const cfg = require('./config');
const exact = require('./exact');
const liability = require('./liability');

const round2 = (x) => Math.round(x * 100) / 100;
const REMUNERATION = 'monthly remuneration';

// Whole completed years between two YYYY-MM-DD dates (UTC, calendar-correct).
function completedYears(joined, asOf) {
  const a = new Date(String(joined).slice(0, 10) + 'T00:00:00Z');
  const b = new Date(String(asOf).slice(0, 10) + 'T00:00:00Z');
  let y = b.getUTCFullYear() - a.getUTCFullYear();
  const m = b.getUTCMonth() - a.getUTCMonth();
  if (m < 0 || (m === 0 && b.getUTCDate() < a.getUTCDate())) y -= 1;
  return Math.max(0, y);
}

// Governance-gated inputs. getRequiredPositiveInt throws 409 when the value is
// PENDING/unset — the deliberate BLOCK until the statutory rate is confirmed.
async function statutory(session) {
  const co = session.company_id;
  return {
    daysPerYear: await cfg.getRequiredPositiveInt(co, 'terminal.severance.days_per_year'),
    divisor: await cfg.getRequiredPositiveInt(co, 'payroll.daily_rate.divisor'),
    minYears: await cfg.getInt(co, 'terminal.min_service_years', 1),
  };
}

async function severanceFor(session, { employeeId, cells, joinedAt, asOf, stat }) {
  const s = stat || await statutory(session);
  if (cells == null) return { employee_id: employeeId, available: false, missing: REMUNERATION };
  const base = await exact.dailyRateBase(session, cells);
  if (!(base > 0)) return { employee_id: employeeId, available: false, missing: REMUNERATION };
  if (!joinedAt) return { employee_id: employeeId, available: false, missing: 'joining date' };
  const years = completedYears(joinedAt, asOf);
  const qualifies = years >= s.minYears;
  const dailyBasic = round2(base / s.divisor);
  return {
    employee_id: employeeId, available: true, completed_years: years, qualifies,
    daily_rate: dailyBasic, days_per_year: s.daysPerYear,
    severance: qualifies ? round2(dailyBasic * s.daysPerYear * years) : 0,
  };
}

// The accrued-severance PROVISION across ACTIVE staff for a matched Exact batch.
// Reads the statutory rate ONCE at the top: if it is still PENDING the whole
// register 409s here — the correct BLOCKED behaviour, never a table of guesses.
async function batchSeverance(session, batchId, asOf) {
  const stat = await statutory(session); // 409s here while PENDING — blocks the register
  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf || '')) ? asOf : new Date().toISOString().slice(0, 10);
  const result = await db.withTenant(session.company_id, async (c) => {
    const rows = (await c.query(
      `SELECT r.matched_employee AS employee_id, r.cells, e.status, e.joined_at::text AS joined_at
         FROM exact_row r JOIN employee e ON e.id = r.matched_employee
        WHERE r.batch_id=$1 AND r.match_status='matched' ORDER BY r.row_no`, [batchId])).rows;
    const available = [], not_available = [], excluded = [];
    let total = 0; const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.employee_id)) { excluded.push({ employee_id: row.employee_id, status: 'duplicate-row' }); continue; }
      seen.add(row.employee_id);
      if (row.status !== 'active') { excluded.push({ employee_id: row.employee_id, status: row.status }); continue; }
      const res = await severanceFor(session, { employeeId: row.employee_id, cells: row.cells, joinedAt: row.joined_at, asOf: when, stat });
      if (res.available) { available.push(res); total = round2(total + res.severance); }
      else not_available.push(res);
    }
    return { batch_id: batchId, as_of: when, basis: `${stat.daysPerYear} days/yr basic, min ${stat.minYears}y service`,
      total, available, not_available, excluded };
  });
  // Wave 7 confidential-forensics: a financial register disclosure is audited
  // (who read which register of which batch) — the same trail Wave 5 added for
  // profile reads, extended to the money registers that bypass a3.assembleProfile.
  await liability.auditRegisterRead(session, 'terminal-severance', batchId,
    result.available.length + result.not_available.length);
  return result;
}

module.exports = { completedYears, severanceFor, batchSeverance, statutory };
