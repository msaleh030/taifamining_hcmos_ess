'use strict';
// Leave service — currently the LR-4 carry-forward lapse nightly job.
//
// LR-3 (calendar-year) + LR-4 (carry lapses after a configurable number of
// years; LOCKED = 1, CHANGED from 2). The lapse window is read from the registry
// per request — nothing here hard-codes "1" (or "2"). A carried entry for year Y
// remains usable through the end of year Y + lapse_years and lapses thereafter.
const db = require('./db');
const cfg = require('./config');
const { HttpError } = require('./errors');

const round1 = (x) => Math.round(x * 10) / 10;
const OPEN = "status <> 'declined' AND status <> 'cancelled'"; // requests that consume balance

async function employeeOf(client, session) {
  if (!session.user_id) return null;
  const r = await client.query('SELECT employee_id FROM app_user WHERE id=$1', [session.user_id]);
  return r.rows[0] ? r.rows[0].employee_id : null;
}
const openCarry = async (c, empId) => Number((await c.query(
  `SELECT coalesce(sum(days),0)::float8 d FROM leave_carry WHERE employee_id=$1 AND lapsed_at IS NULL`, [empId])).rows[0].d);
const takenOf = async (c, empId, type) => Number((await c.query(
  `SELECT coalesce(sum(days),0)::float8 d FROM leave_request WHERE employee_id=$1 AND leave_type=$2 AND ${OPEN}`,
  [empId, type])).rows[0].d);

// Run the nightly carry-lapse for one tenant, as of `asOf` (a YYYY-MM-DD string;
// injected so the job is deterministic and testable rather than clock-bound).
// Marks every still-open carry whose window has closed as lapsed, on the audit
// chain. Returns the rows it lapsed.
async function lapseCarry(companyId, asOf) {
  return db.withTenant(companyId, async (c) => {
    // Registry-gated: lapse window must be a confirmed value (blocks if [TBC]).
    const lapseYears = await cfg.getRequiredInt(companyId, 'leave.carry.lapse_years', c);

    // A carry for year Y lapses once asOf's calendar year exceeds Y + lapseYears.
    const r = await c.query(
      `UPDATE leave_carry
          SET lapsed_at = $1::timestamptz
        WHERE lapsed_at IS NULL
          AND carried_for_year + $2 < EXTRACT(YEAR FROM $1::date)
        RETURNING id, employee_id, days, carried_for_year`,
      [asOf, lapseYears]);

    for (const row of r.rows) {
      await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
        companyId, 'system@nightly', 'SYS', 'leave.carry.lapse',
        'leave_carry', row.id,
        { days: Number(row.days), carried_for_year: row.carried_for_year },
        { days: 0, lapsed: true }]);
    }
    return { lapsed: r.rows, lapse_years: lapseYears, as_of: asOf };
  });
}

// LV-01/05: the requester's own leave balance. Annual = entitlement (LR-1) +
// carry (LR-4) − taken. Sick is a SEPARATE bucket (LR-7): its taken is tracked,
// but the limit is [TBC] so `available` is not-available (never a guessed number).
async function balance(session) {
  const co = session.company_id;
  return db.withTenant(co, async (c) => {
    const empId = await employeeOf(c, session);
    if (!empId) throw new HttpError(403, 'no employee for user');
    const entitlement = await cfg.getInt(co, 'leave.entitlement.default', 21, c);
    const carried = await openCarry(c, empId);
    const annualTaken = await takenOf(c, empId, 'annual');
    const sickTaken = await takenOf(c, empId, 'sick');
    return {
      employee_id: empId,
      annual: { entitlement, carried, taken: annualTaken, available: round1(entitlement + carried - annualTaken) },
      sick: { taken: sickTaken, available: { available: false, missing: 'sick-leave rule (LR-7)' } },
    };
  });
}

// LV-02: apply for leave (self-service). Annual enforces LR-5 (max continuous,
// HoH override) and available balance. Sick draws its OWN bucket — never annual.
async function apply(session, input = {}) {
  const co = session.company_id;
  const { leave_type, days, weeks, hoh_override } = input;
  if (weeks != null) await cfg.getRequired(co, 'leave.weeks_to_days'); // LR-2 [TBC] → blocks
  if (!['annual', 'sick'].includes(leave_type)) throw new HttpError(400, 'invalid leave type');
  const d = Number(days);
  if (!(d > 0)) throw new HttpError(400, 'days must be positive');

  return db.withTenant(co, async (c) => {
    const empId = await employeeOf(c, session);
    if (!empId) throw new HttpError(403, 'no employee for user');

    if (leave_type === 'annual') {
      const max = await cfg.getInt(co, 'leave.max_continuous_days', 14, c); // LR-5
      if (d > max && !hoh_override) throw new HttpError(409, `exceeds ${max} continuous days without HoH override`);
      const entitlement = await cfg.getInt(co, 'leave.entitlement.default', 21, c);
      const available = entitlement + (await openCarry(c, empId)) - (await takenOf(c, empId, 'annual'));
      if (d > available) throw new HttpError(409, 'insufficient annual balance');
    }
    // sick: separate bucket (LR-7 limits [TBC], not enforced here) — never annual.
    const r = await c.query(
      `INSERT INTO leave_request(company_id, employee_id, leave_type, days, hoh_override, status)
       VALUES ($1,$2,$3,$4,$5,'applied') RETURNING id`, [co, empId, leave_type, d, !!hoh_override]);
    return { id: r.rows[0].id, employee_id: empId, leave_type, days: d };
  });
}

module.exports = { lapseCarry, balance, apply };
