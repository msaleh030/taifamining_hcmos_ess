'use strict';
// Leave service — balances, applications, and the GOING-FORWARD carry rule.
//
// v1.5 LR-4/LR-8/LR-9 (REPLACES the old flat one-year lapse): at each employee's
// EMPLOYMENT ANNIVERSARY carried annual leave is capped at leave.carry.cap_days
// (excess forfeited then); at anniversary + leave.carry.grace_months any carried
// days still UNUSED are forfeited (days taken since the anniversary survive —
// they were spent, never clawed back). The opening bucket (opening_bucket=true)
// is EXEMPT — never touched — until the carry policy lands (OB-5). Both policy
// values (10 days / 3 months) live in the registry and are pinned by
// test/leave.test.js — do not change without Kira.
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

// ── Date helpers for the anniversary math (pure string arithmetic on
// 'YYYY-MM-DD'; day clamped so 29 Feb / month-length overflows land on the last
// valid day, matching Postgres interval semantics). ─────────────────────────
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(d, daysInMonth(y, m))).padStart(2, '0')}`;

// The most recent employment anniversary on or before asOf, and its cycle year.
function anniversaryOf(joined, asOf) {
  const [jy, jm, jd] = joined.slice(0, 10).split('-').map(Number);
  let y = Number(asOf.slice(0, 4));
  if (iso(y, jm, jd) > asOf) y -= 1;
  if (y <= jy) y = jy + 1; // the first anniversary is one year after joining
  const ann = iso(y, jm, jd);
  return ann <= asOf ? { cycleYear: y, anniversary: ann } : null;
}

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = (m - 1) + months;
  return iso(y + Math.floor(total / 12), (total % 12) + 1, d);
}

// Forfeit `amount` carried days FIFO (oldest carried_for_year first) across the
// employee's OPEN, NON-OPENING carry rows. A row drawn to zero is closed
// (lapsed_at set); a partially drawn row keeps its remainder.
async function forfeitFifo(c, employeeId, amount, asOf) {
  let left = amount;
  const rows = (await c.query(
    `SELECT id, days FROM leave_carry
      WHERE employee_id=$1 AND lapsed_at IS NULL AND opening_bucket=false
      ORDER BY carried_for_year, id`, [employeeId])).rows;
  for (const r of rows) {
    if (left <= 0) break;
    const take = Math.min(Number(r.days), left);
    const remain = round1(Number(r.days) - take);
    if (remain <= 0) await c.query(`UPDATE leave_carry SET days=0, lapsed_at=$2::timestamptz WHERE id=$1`, [r.id, asOf]);
    else await c.query(`UPDATE leave_carry SET days=$2 WHERE id=$1`, [r.id, remain]);
    left = round1(left - take);
  }
}

// ── v1.5 LR-4/LR-8/LR-9: the daily carry sweep (REPLACES the flat lapse). ────
// Deterministic (asOf injected) and IDEMPOTENT: the leave_carry_sweep ledger
// records one row per (employee, cycle, phase), so a re-run forfeits nothing.
// Opening-bucket rows are exempt by construction (every query here filters
// opening_bucket=false). Each forfeiture writes an audit row (employee, days,
// reason, timestamp).
async function carrySweep(companyId, asOf) {
  return db.withTenant(companyId, async (c) => {
    // Policy values from the registry — pinned by test/leave.test.js; BLOCK if unset.
    const cap = await cfg.getRequiredInt(companyId, 'leave.carry.cap_days', c);
    const graceMonths = await cfg.getRequiredInt(companyId, 'leave.carry.grace_months', c);

    // Employees with an employment date on record AND open non-opening carry.
    const emps = (await c.query(
      `SELECT DISTINCT e.id, e.joined_at::text AS joined FROM employee e
         JOIN leave_carry lc ON lc.employee_id = e.id
        WHERE e.joined_at IS NOT NULL AND lc.lapsed_at IS NULL AND lc.opening_bucket=false`)).rows;

    const openOf = async (id) => Number((await c.query(
      `SELECT coalesce(sum(days),0)::float8 d FROM leave_carry
        WHERE employee_id=$1 AND lapsed_at IS NULL AND opening_bucket=false`, [id])).rows[0].d);
    const ledgered = async (id, year, phase) => (await c.query(
      `SELECT 1 FROM leave_carry_sweep WHERE employee_id=$1 AND cycle_year=$2 AND phase=$3`,
      [id, year, phase])).rows.length > 0;
    const audit = (empId, action, before, after) => c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
      companyId, 'system@nightly', 'SYS', action, 'leave_carry', empId, before, after]);

    const processed = [];
    for (const e of emps) {
      const cycle = anniversaryOf(e.joined, asOf);
      if (!cycle) continue; // no anniversary reached yet
      const { cycleYear, anniversary } = cycle;

      // Phase 1 (LR-8): AT the anniversary, cap carried days at `cap`.
      if (!(await ledgered(e.id, cycleYear, 'cap'))) {
        const open = await openOf(e.id);
        const excess = round1(Math.max(0, open - cap));
        if (excess > 0) {
          await forfeitFifo(c, e.id, excess, asOf);
          await audit(e.id, 'leave.carry.cap',
            { carried: open, cap },
            { carried: round1(open - excess), forfeited: excess, reason: `carry capped at ${cap}d at anniversary ${anniversary}`, as_of: asOf });
        }
        await c.query(
          `INSERT INTO leave_carry_sweep (company_id, employee_id, cycle_year, phase, days_forfeited)
           VALUES ($1,$2,$3,'cap',$4)`, [companyId, e.id, cycleYear, excess]);
        processed.push({ employee_id: e.id, cycle_year: cycleYear, phase: 'cap', forfeited: excess });
      }

      // Phase 2 (LR-9): at anniversary + grace, forfeit carried days still UNUSED.
      // Days taken since the anniversary count as consumed carry (used days
      // survive — never clawed back); only the remainder is forfeited.
      const graceEnd = addMonths(anniversary, graceMonths);
      if (asOf >= graceEnd && !(await ledgered(e.id, cycleYear, 'forfeit'))) {
        const open = await openOf(e.id);
        const taken = Number((await c.query(
          `SELECT coalesce(sum(days),0)::float8 d FROM leave_request
            WHERE employee_id=$1 AND leave_type='annual' AND ${OPEN}
              AND applied_at >= $2::date AND applied_at::date <= $3::date`,
          [e.id, anniversary, asOf])).rows[0].d);
        const unused = round1(Math.max(0, open - taken));
        if (unused > 0) {
          await forfeitFifo(c, e.id, unused, asOf);
          await audit(e.id, 'leave.carry.forfeit',
            { carried: open, taken_since_anniversary: taken },
            { carried: round1(open - unused), forfeited: unused, reason: `unused carry forfeited at anniversary+${graceMonths}mo (${graceEnd})`, as_of: asOf });
        }
        await c.query(
          `INSERT INTO leave_carry_sweep (company_id, employee_id, cycle_year, phase, days_forfeited)
           VALUES ($1,$2,$3,'forfeit',$4)`, [companyId, e.id, cycleYear, unused]);
        processed.push({ employee_id: e.id, cycle_year: cycleYear, phase: 'forfeit', forfeited: unused });
      }
    }
    return { as_of: asOf, cap_days: cap, grace_months: graceMonths, processed };
  });
}

// Parse the LR-7 sick rule ('full:63,half:63,cert_from_day:1') into a structured
// entitlement. Returns null if the rule is [TBC]/absent (caller shows not-available).
function parseSickRule(v) {
  if (cfg.isPending(v)) return null;
  const kv = Object.fromEntries(v.split(',').map((p) => p.split(':').map((s) => s.trim())));
  const full = Number(kv.full), half = Number(kv.half), cert = Number(kv.cert_from_day);
  if (!Number.isFinite(full) || !Number.isFinite(half)) return null;
  return { full_pay_days: full, half_pay_days: half, entitlement: full + half,
    certificate_from_day: Number.isFinite(cert) ? cert : 1 };
}

// LV-01/05: the requester's own leave balance. Annual = entitlement (LR-1) +
// carry (LR-4) − taken. Sick is a SEPARATE bucket (LR-7 CONFIRMED v1.4: 63 full +
// 63 half = 126 entitlement, certificate from day one); its taken counts against
// the 126. If a tenant ever unsets the rule, the card reverts to not-available.
async function balance(session) {
  const co = session.company_id;
  return db.withTenant(co, async (c) => {
    const empId = await employeeOf(c, session);
    if (!empId) throw new HttpError(403, 'no employee for user');
    const entitlement = await cfg.getInt(co, 'leave.entitlement.default', 21, c);
    const carried = await openCarry(c, empId);
    const annualTaken = await takenOf(c, empId, 'annual');
    const sickTaken = await takenOf(c, empId, 'sick');
    const sickRule = parseSickRule(await cfg.getConfig(co, 'leave.sick.rule', null, c));
    const sick = sickRule
      ? { ...sickRule, taken: sickTaken, available: round1(sickRule.entitlement - sickTaken) }
      : { taken: sickTaken, available: { available: false, missing: 'sick-leave rule (LR-7)' } };
    return {
      employee_id: empId,
      annual: { entitlement, carried, taken: annualTaken, available: round1(entitlement + carried - annualTaken) },
      sick,
    };
  });
}

// LV-02: apply for leave (self-service). Annual enforces LR-5 (max continuous,
// HoH override) and available balance. Sick draws its OWN bucket — never annual.
async function apply(session, input = {}) {
  const co = session.company_id;
  const { leave_type, days, weeks, hoh_override } = input;
  if (!['annual', 'sick'].includes(leave_type)) throw new HttpError(400, 'invalid leave type');
  // LR-2 CONFIRMED (v1.4): entitlement WEEKS convert to real days at 7 calendar
  // days/week (2 weeks → 14, 4 → 28; pinned by test/f3.test.js). This is NOT the
  // pay divisor — the 30-day monthly→daily basis lives only in the daily-rate/
  // liability path. Read as REQUIRED so a weeks request BLOCKS if a tenant unsets it.
  let d = Number(days);
  if (days == null && weeks != null) {
    const daysPerWeek = await cfg.getRequiredInt(co, 'leave.weeks_to_days'); // 7 (LR-2)
    d = Number(weeks) * daysPerWeek;
  }
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

module.exports = { carrySweep, balance, apply };
