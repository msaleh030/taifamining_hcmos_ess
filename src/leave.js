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
const sitescope = require('./sitescope');
const { HttpError } = require('./errors');

const round1 = (x) => Math.round(x * 10) / 10;
const OPEN = "status <> 'declined' AND status <> 'cancelled'"; // requests that consume balance

// session→employee (device bootstrap included; joined_at is the cycle anchor)
const { employeeOf, employeeRowOf } = require('./identity');
const openCarry = async (c, empId) => Number((await c.query(
  `SELECT coalesce(sum(days),0)::float8 d FROM leave_carry WHERE employee_id=$1 AND lapsed_at IS NULL`, [empId])).rows[0].d);
// Consumption within the CURRENT entitlement cycle (bughunt-B #1/#2): `since`
// bounds the sum to the cycle start so entitlement RENEWS at each anniversary
// and a prior-cycle day is never both balance-deducted AND carry-forfeited
// (the double charge). since=null (no employment date) keeps the lifetime sum.
const takenOf = async (c, empId, type, since = null) => Number((await c.query(
  `SELECT coalesce(sum(days),0)::float8 d FROM leave_request
    WHERE employee_id=$1 AND leave_type=$2 AND ${OPEN}${since ? ' AND applied_at >= $3::date' : ''}`,
  since ? [empId, type, since] : [empId, type])).rows[0].d);

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

// The current entitlement cycle's start: the most recent employment anniversary,
// or the join date itself during the first year. Shares anniversaryOf() with the
// carry sweep so balance() and the sweep count consumption over the SAME window.
function cycleStartFor(joined, asOf) {
  if (!joined) return null;
  const ann = anniversaryOf(joined.slice(0, 10), asOf);
  return ann ? ann.anniversary : joined.slice(0, 10);
}
const todayIso = () => new Date().toISOString().slice(0, 10);

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
    const emp = await employeeRowOf(c, session);
    if (!emp) throw new HttpError(403, 'no employee for user');
    const empId = emp.id;
    const entitlement = await cfg.getInt(co, 'leave.entitlement.default', 21, c);
    const carried = await openCarry(c, empId);
    // Entitlement RENEWS per anniversary cycle (#1): consumption is counted from
    // the current cycle's start, the SAME window the carry sweep forfeits over (#2).
    const since = cycleStartFor(emp.joined, todayIso());
    const annualTaken = await takenOf(c, empId, 'annual', since);
    const sickTaken = await takenOf(c, empId, 'sick', since);
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

  // Optional request window (C10): the dates the coverage meter computes over.
  // `days` stays authoritative for balance math — the window never changes it.
  const { from_date, to_date } = input;
  const isoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v));
  if ((from_date == null) !== (to_date == null)) throw new HttpError(400, 'from_date and to_date go together');
  if (from_date != null) {
    if (!isoDate(from_date) || !isoDate(to_date)) throw new HttpError(400, 'dates must be YYYY-MM-DD');
    if (String(to_date) < String(from_date)) throw new HttpError(400, 'to_date before from_date');
  }

  return db.withTenant(co, async (c) => {
    const emp = await employeeRowOf(c, session);
    if (!emp) throw new HttpError(403, 'no employee for user');
    const empId = emp.id;

    if (leave_type === 'annual') {
      // Serialize concurrent applies for the SAME employee so the read-check-
      // insert cannot double-spend: two simultaneous requests would each read
      // the pre-insert balance and both pass. The xact-scoped advisory lock
      // makes the second wait for the first to commit, then see its row.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [empId]);
      const max = await cfg.getInt(co, 'leave.max_continuous_days', 14, c); // LR-5
      if (d > max && !hoh_override) throw new HttpError(409, `exceeds ${max} continuous days without HoH override`);
      const entitlement = await cfg.getInt(co, 'leave.entitlement.default', 21, c);
      // Round to match the balance card (round1); an unrounded float would
      // falsely reject an exact-integer request at a fractional-carry boundary.
      // Consumption cycle-scoped (#1) — the same window balance() reports.
      const since = cycleStartFor(emp.joined, todayIso());
      const available = round1(entitlement + (await openCarry(c, empId)) - (await takenOf(c, empId, 'annual', since)));
      if (d > available) throw new HttpError(409, 'insufficient annual balance');
    }
    // sick: separate bucket (LR-7 limits [TBC], not enforced here) — never annual.
    const r = await c.query(
      `INSERT INTO leave_request(company_id, employee_id, leave_type, days, hoh_override, status, from_date, to_date)
       VALUES ($1,$2,$3,$4,$5,'applied',$6,$7) RETURNING id`,
      [co, empId, leave_type, d, !!hoh_override, from_date || null, to_date || null]);
    return { id: r.rows[0].id, employee_id: empId, leave_type, days: d,
             ...(from_date ? { from_date, to_date } : {}) };
  });
}

// ═══ C10 — approve + coverage (Kira's build order, 2026-07-06) ═══════════════
// LV-03 approval queue and decision; SOD-01 maker ≠ checker (same-user-403);
// LR-6 coverage is WARN-NOT-BLOCK: a below-threshold approval may proceed but
// only with the acknowledged override, which is audited (UNI-06).

// LR-6 thresholds: 'default:1,R13:5' → Map(role → minimum present). 'default'
// is the floor for any role without its own entry (Kira, 2026-07-07: at least
// one person must remain on site per role before the approver is warned).
// A [TBC]/unset value means "not configured" — null.
function parseThresholds(v) {
  if (cfg.isPending(v)) return null;
  const m = new Map();
  for (const part of String(v).split(',')) {
    const [role, n] = part.split(':').map((s) => s.trim());
    if (role && Number.isFinite(Number(n))) m.set(role, Number(n));
  }
  return m.size ? m : null;
}

// Coverage of the requester's role at their site over the request window:
// present = active same-role colleagues at the site (excluding the requester)
// not on APPROVED leave overlapping the window. Statuses:
//   pending — thresholds [TBC] (LR-6 unconfigured) or the request has no
//             window: nothing to warn on, approval proceeds without override;
//   ok      — present >= threshold (or the role has no threshold);
//   warn    — present < threshold: approvable ONLY with the audited override.
async function coverageOf(c, co, reqRow) {
  const thresholds = parseThresholds(await cfg.getConfig(co, 'leave.coverage.thresholds', null, c));
  if (!thresholds) return { status: 'pending', reason: 'leave.coverage.thresholds [TBC] — LR-6 not configured' };
  const emp = (await c.query('SELECT site_id, role_code FROM employee WHERE id=$1', [reqRow.employee_id])).rows[0];
  if (!emp) return { status: 'pending', reason: 'requester has no employee record' };
  const threshold = thresholds.get(emp.role_code) ?? thresholds.get('default');
  if (threshold == null) return { status: 'ok', role: emp.role_code, reason: 'no threshold for role' };
  if (!reqRow.from_date || !reqRow.to_date) return { status: 'pending', reason: 'request has no from/to window' };
  const present = (await c.query(
    `SELECT count(*)::int n FROM employee e
      WHERE e.site_id=$1 AND e.role_code=$2 AND e.status='active' AND e.id <> $3
        AND NOT EXISTS (SELECT 1 FROM leave_request lr
              WHERE lr.employee_id = e.id AND lr.status='approved'
                AND lr.from_date IS NOT NULL AND lr.from_date <= $5::date AND lr.to_date >= $4::date)`,
    [emp.site_id, emp.role_code, reqRow.employee_id, reqRow.from_date, reqRow.to_date])).rows[0].n;
  return { status: present < threshold ? 'warn' : 'ok', role: emp.role_code, site_id: emp.site_id,
           present, threshold, window: { from: String(reqRow.from_date).slice(0, 10), to: String(reqRow.to_date).slice(0, 10) } };
}

// GET /leave/requests — the approval queue (status 'applied'), each with its
// coverage meter. A site-bound approver (R02/R04) sees only their own site.
async function queue(session) {
  const co = session.company_id;
  return db.withTenant(co, async (c) => {
    const sites = await sitescope.scopeSites(c, session); // null = central; array = the scope SET
    const siteFilter = sites ? `AND e.site_id IN (${sites.map((_, i) => `$${i + 1}`).join(',')})` : '';
    const rows = (await c.query(
      `SELECT lr.id, lr.employee_id, e.full_name, e.emp_no, e.role_code, e.site_id, s.name AS site,
              lr.leave_type, lr.days::float8 AS days, lr.from_date::text AS from_date,
              lr.to_date::text AS to_date, lr.hoh_override, lr.applied_at::text AS applied_at
         FROM leave_request lr
         JOIN employee e ON e.id = lr.employee_id
         LEFT JOIN site s ON s.id = e.site_id
        WHERE lr.status = 'applied' ${siteFilter}
        ORDER BY lr.applied_at`, sites || [])).rows;
    const pending = [];
    for (const r of rows) pending.push({ ...r, coverage: await coverageOf(c, co, r) });
    return { pending };
  });
}

// POST /leave/requests/:id/decide {approve, override_ack?, note?}
async function decide(session, requestId, input = {}) {
  const co = session.company_id;
  const { approve, override_ack, note } = input;
  if (typeof approve !== 'boolean') throw new HttpError(400, 'approve must be true or false');
  return db.withTenant(co, async (c) => {
    const req = (await c.query('SELECT * FROM leave_request WHERE id=$1', [requestId])).rows[0];
    if (!req) throw new HttpError(404, 'request not found');
    if (req.status !== 'applied') throw new HttpError(409, `already ${req.status}`);

    // SOD-01: the requester never decides their own leave (same-user-403).
    const own = await employeeOf(c, session);
    if (own && own === req.employee_id) throw new HttpError(403, 'cannot decide own leave (SOD-01)');

    // A site-bound approver decides only requests inside their scope SET.
    const sites = await sitescope.scopeSites(c, session);
    if (sites) {
      const emp = (await c.query('SELECT site_id FROM employee WHERE id=$1', [req.employee_id])).rows[0];
      if (!emp || !sites.includes(emp.site_id)) throw new HttpError(403, 'request outside your site');
    }

    // LR-6 on approval: warn-not-block — a coverage gap needs the acknowledged
    // override; the 409 carries the meter so the approver sees exactly the gap.
    let coverage = null, overridden = false;
    if (approve) {
      coverage = await coverageOf(c, co, req);
      if (coverage.status === 'warn') {
        if (!override_ack) {
          throw new HttpError(409, 'coverage below threshold — acknowledge the gap to proceed (LR-6 warn-not-block)', { coverage });
        }
        overridden = true;
      }
    }

    const status = approve ? 'approved' : 'declined';
    await c.query(
      `UPDATE leave_request SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4, coverage_override=$5
        WHERE id=$1`, [requestId, status, session.user_id, note || null, overridden]);

    // UNI-06: the override is its own audit event — approver, role, the gap.
    if (overridden) {
      await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
        co, String(session.user_id), session.role_code, 'leave.coverage.override',
        'leave_request', requestId, { coverage }, { acknowledged: true, decided: status }]);
    }
    await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
      co, String(session.user_id), session.role_code, `leave.${status}`,
      'leave_request', requestId, { status: 'applied' }, { status, note: note || null }]);

    // The requester hears the outcome in ESS.
    const emp = (await c.query('SELECT full_name FROM employee WHERE id=$1', [req.employee_id])).rows[0];
    await c.query(
      `INSERT INTO notification (company_id, employee_id, audience, recipient, kind, body)
       VALUES ($1,$2,'ess',$3,'leave.decision',$4)`,
      [co, req.employee_id, emp ? emp.full_name : 'employee',
       { request_id: requestId, status, ...(overridden ? { coverage_override: true } : {}) }]);

    return { id: requestId, status, coverage_override: overridden, ...(coverage ? { coverage } : {}) };
  });
}

module.exports = { carrySweep, balance, apply, queue, decide };
