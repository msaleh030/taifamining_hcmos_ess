'use strict';
// Runtime configuration lives in the `config` table, per tenant — NEVER in code.
// These are the DEFAULT values seeded for a tenant. Auth lockout (threshold /
// duration) runs on defensible defaults documented as pending ratification — it
// is NOT gated, because auth cannot block a login on a [TBC] value; it stays
// overridable in `config`. The genuinely-gated items use the PENDING sentinel
// and BLOCK at use. Every value is read from `config` at request time so it can
// change without a deploy — none of this is hard-coded policy.
const { query } = require('./db');
const { HttpError } = require('./errors');

// Sentinel for a registry key whose value is confirmed-PENDING governance. It is
// stored explicitly (so the key EXISTS in the registry and is auditable) but any
// code path that needs it must BLOCK — never silently default. Empty string is
// treated the same way by the required-value accessors below.
const PENDING = '__TBC__';

const DEFAULT_CONFIG = {
  // Auth lockout — defensible default, PENDING RATIFICATION (not gated: auth must
  // function, so these apply now and stay overridable in config).
  'auth.lockout.threshold': '5',     // failed attempts before lock
  'auth.lockout.duration':  '900',   // lock seconds (15 min)

  // session lifetime
  'session.ttl':            '3600',  // console session seconds (1 h)
  'session.field.ttl':      '43200', // field/kiosk session seconds (12 h shift)

  // [TBC] permitted owners for credential operations (role lists)
  'password.reset.owner':       'R03,R12', // HR Officer, System Admin
  'pin.reset.owner':            'R03,R12', // [TBC] device-enrolment/PIN owner
  'device.reenrolment.owner':   'R12',     // [TBC] new phone / replaced kiosk

  // default role for a field session when the device's employee has no app_user
  'field.default.role':     'R13',

  // ── Slice 2: Employee Master ──────────────────────────────────────────────
  // A3 confidential-field visibility (role lists). [TBC] 4 July: +R08 pay, +R11
  // medical — kept OUT by default (conservative least privilege), flip in config.
  'a3.pay.roles':          'R07,R09,R11',
  'a3.medical.roles':      'R05,R06,R10',
  'a3.disciplinary.roles': 'R05,R06,R07,R11',

  // Roles with NO directory access at all (server returns 403 on /employees*).
  'directory.deny.roles':  'R08,R09,R12,R13',

  // ── Disciplinary (Slice 4, SoD matrix per registry RTL/CR/TM/001/2026) ────
  // Issuer and checker role-sets are DISJOINT, so a permitted issuer and a
  // permitted checker are always different roles (SoD by construction); the
  // service additionally enforces different persons and subject ≠ actor.
  'disciplinary.issuer.roles':  'R02,R05,R06',   // supervisor + HSE issue
  'disciplinary.checker.roles': 'R04,R11',       // HR Manager / HR Director confirm
  'disciplinary.hr.role':       'R04',           // HR named on the console notification

  // Maker-checker: who may propose / approve a change, per editable field.
  // Generic fallback applies when a field-specific key is absent.
  'field_change.makers':         'R02,R03,R04',
  'field_change.checkers':       'R03,R04,R11',
  'field_change.makers.phone':   'R02,R03,R04',
  'field_change.checkers.phone': 'R03,R04,R11',

  // Directory paging — server-side bound; first page must not full-table scan.
  'employees.page_size':   '50',
  'employees.page_max':    '200',

  // ── Slice 3: Employee-number scheme — TMCL-<LOC>-<SEQ> ─────────────────────
  // Format is prefix + location code + per-location zero-padded sequence, no year
  // segment. Everything below is config: the generator/validator (src/empno.js)
  // hard-codes none of it.
  'empno.prefix':     'TMCL',
  'empno.seq_width':  '4',          // SEQ is 4-digit zero-padded
  // Single source of truth for locations: "key:code" pairs. An EMPTY code blocks
  // generation for that location. LOCKED: Nyanzaga = NZ. Enum {HO,MW,NM,NZ}.
  'empno.locations':  'ho:HO,mw:MW,nm:NM,nyanzaga:NZ',
  // [TBC] behaviour past SEQ 9999 per location — BLOCKS (generator refuses to
  // overflow; it does NOT silently widen the field) until governance decides.
  'empno.rollover':       '',
  // [TBC] whether to add a company segment to the string (LOCKED answer for now:
  // NO — company_id is on every row). The decision to ADD one is pending.
  'empno.company_segment': PENDING,

  // ── Leave (LR-*) ──────────────────────────────────────────────────────────
  'leave.year.basis':         'calendar',  // LR-3 calendar-year
  'leave.carry.lapse_years':  '1',         // LR-4 carry lapses after ONE year (CHANGED from 2)
  'leave.max_continuous_days':'14',        // LR-5 max 14 continuous (HoH override)
  'leave.entitlement.default':'21',        // LR-1 entitlement map (default grade)
  // LR-2 CONFIRMED (v1.4): a leave period expressed in months converts to days on
  // a 30-day month — the SAME 30-day basis as PC-1's daily-rate divisor. Read as a
  // required value so a period request still BLOCKS if a tenant ever unsets it.
  'leave.days_per_month':     '30',        // LR-2 (was leave.weeks_to_days [TBC])
  'leave.coverage.thresholds':PENDING,     // LR-6 [TBC] per-role coverage
  // LR-7 CONFIRMED (v1.4): sick leave = 63 days full pay + 63 days half pay
  // (126 total); a medical certificate is required from day one. full/half is a
  // PAY split; both count against the 126-day entitlement for balance purposes.
  'leave.sick.rule':          'full:63,half:63,cert_from_day:1', // LR-7

  // ── Payroll (PC-*) ────────────────────────────────────────────────────────
  // PC-1 daily-rate divisor = 30 (registry). This is THE pay daily-rate basis,
  // used by payroll AND by leave pay/liability. There is no 31 divisor; a 31-day
  // proration, if ever needed, must be raised as its own registry item.
  'payroll.daily_rate.divisor':'30',
  'payroll.fixed_allowances': 'house,transport,responsibility', // PC-1 fixed-allowance set
  'payroll.gross_components': 'house,transport,responsibility', // PC-3 (must equal PC-1's set)
  'payroll.partial_period':   PENDING,     // PC-2 [TBC]

  // ── Geofence clock-in (SS-3, registry v1.4 CONFIRMED) ─────────────────────
  // Zones themselves live in geofence_zone (per site). These tune the validator.
  // CONFIRMED: accept when distance <= radius + min(device_accuracy, 50m).
  'geofence.tolerance.policy':  'accuracy',  // accuracy | none
  'geofence.tolerance.max_m':   '50',
  // CONFIRMED: above this reported accuracy the fix is too coarse to trust — the
  // clock-in is neither accepted nor rejected; the caller is asked to retry.
  'geofence.accuracy.retry_above_m': '100',
  // Defensive: a site with NO zones does not hard-reject (HO now has a zone, so
  // this no longer applies to HO; kept for any unmapped site). 'allow' | 'reject'.
  'geofence.empty_zone.policy': 'allow',

  // ── Exact payroll ingestion (Slice 8, contract v1.2 / registry v1.3) ──────
  'exact.contract.version': 'v1.2',
  'exact.section_row':      '6',   // two-row header: section labels on row 6…
  'exact.header_row':       '7',   // …column headers on row 7 (1-based)
  // EX-1 CONFIRMED: match Exact rows on legacy_id (old master-file ID), NOT
  // emp_no/TMCL. New joiners with only a TMCL number surface as unmatched.
  'exact.match.key':        'legacy_id',
  // EX-4 CONFIRMED: col 28 is "TOTAL PAY" (renamed from Total Allowance).
  'exact.col.total_pay':       '28',
  'exact.col.total_deduction': '42',
  // EX-3 CONFIRMED: NET PAY is column AS (0-indexed 44) = Total Pay − Total Deduction.
  'exact.netpay.source':    'col:44',
  // EX-2 CONFIRMED daily-rate base (PC-1): BASIC + Housing(15%) + Responsibility
  // + Project + Medical + Housing(fixed) + Fixed Overtime + Transport(10%).
  // Positions are the contract's earnings columns; EXCLUDE overtime cols 21 & 24.
  // EX-2 daily-rate base — NAME-KEYED (resolved to positions via the column
  // contract), confirmed against the real Exact export, so a column can never
  // silently drift. INCLUDE = the fixed-pay set; EXCLUDE = the variable
  // overtime/rotation/night components. This is the single base used by payroll
  // and by leave pay/liability.
  'exact.dailyrate.include_names': 'BASIC SALARY,HOUSING ALLOWANCE,RESPONSIBILITY,PROJECT,MEDICAL,HOUSING ALL,FIXED OVERTIME,TRANSPORT',
  'exact.dailyrate.exclude_names': 'ROTATION,OVERTIME NORMAL,OVERTIME HOLIDAY,NIGHT SHIFT',
  // Full-period control-totals reconciliation (AC-EXACT-07) — still gated until a
  // real populated period arrives; the per-row net check runs now (EX-3).
  'exact.reconciliation':   PENDING,

  // ── Documents / retention / region (DA-1, AC-2) ──────────────────────────
  'doc.lead_time.contract':   '30',        // DA-1 lead times (days)
  'doc.lead_time.permit':     '60',
  'doc.lead_time.licence':    '45',
  'doc.lead_time.medical':    '30',
  // DA-2 notified role per document type — APPLIED registry values (pending
  // UAT ratification, but these ARE the values, not placeholders).
  'doc.notify.role.contract': 'R05',       // HR Officer
  'doc.notify.role.permit':   'R06',       // Project HR
  'doc.notify.role.licence':  'R10',       // SHEQ
  'doc.notify.role.medical':  'R10',       // SHEQ
  // Support ticket channels (ES-5).
  'support.channels':         'in_app,email',
  'retention.audit_years':    '7',
  'retention.safety_years':   '10',
  'region':                   'af-south-1',

  // ── Analytics scorecard (Slice 7, KPI) ────────────────────────────────────
  // Steering decision: the org KPI scorecard is active only if the client buys
  // analytics. The engine + personal My KPIs (E8) exist regardless.
  'analytics.enabled':        'false',

  // ── Pending governance refinements (registered so they are gated, not silently
  //    defaulted; nothing reads these until a value is set) ───────────────────
  'pending.a3.r08_pay':       PENDING,     // A3: R08 pay visibility
  'pending.a3.r11_medical':   PENDING,     // A3: R11 CEO medical
  'pending.a3.r05_scope':     PENDING,     // A3: R05 HR scope (central vs site)
  'jml.probation':            PENDING,     // JML-3 [TBC]
  'es.reenrolment.owner':     PENDING,     // ES-1 device re-enrolment owner [TBC]
  'es.channels':              PENDING,     // ES-4 [TBC]
  'asset.owner.role':         PENDING,     // [TBC]
  'competency.steps':         PENDING,     // [TBC]
};

// Site-scope is data/config (the site_scope table), not hard-coded. These are
// the seeded defaults. [TBC] site_scope.R05 — HSE is site-based in mining, so
// scoped=true by decision; flip in the table if governance says central.
const SITE_SCOPE = {
  R01: true,  R02: true,  R03: true,  R04: true,  R05: true,  R06: true,
  R07: false, R08: false, R09: false, R10: false, R11: false, R12: false, R13: false,
};

// Cached per-tenant reads are unnecessary here; config_get is a cheap indexed
// lookup via a SECURITY DEFINER function (bootstrap-safe, no app.company_id needed).
//
// `exec` (optional): when a caller is ALREADY inside a withTenant transaction it
// MUST pass its client so the read runs on the same connection. Acquiring a
// second pool connection from inside a held transaction risks pool-exhaustion
// deadlock when concurrent transactions approach the pool size. Omit it for
// standalone reads (the pool path).
function runner(exec) {
  return exec ? (sql, p) => exec.query(sql, p) : query;
}

async function getConfig(companyId, key, fallback = null, exec = null) {
  const r = await runner(exec)('SELECT config_get($1,$2) AS v', [companyId, key]);
  const v = r.rows[0] && r.rows[0].v;
  return v === null || v === undefined ? fallback : v;
}

async function getInt(companyId, key, fallback, exec = null) {
  const v = await getConfig(companyId, key, null, exec);
  return v === null ? fallback : parseInt(v, 10);
}

// Parse a comma-separated role list from config.
async function getOwnerRoles(companyId, key, exec = null) {
  const v = await getConfig(companyId, key, '', exec);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// Comma-separated config as a Set, with a code fallback if the key is unset.
async function getRoleSet(companyId, key, fallbackCsv = '', exec = null) {
  const v = await getConfig(companyId, key, null, exec);
  const csv = v === null ? fallbackCsv : v;
  return new Set(csv.split(',').map((s) => s.trim()).filter(Boolean));
}

// True when a registry value is absent or confirmed-PENDING governance.
const isPending = (v) => v === null || v === undefined || v === '' || v === PENDING;

// REQUIRED value: a confirmed-PENDING ([TBC]) or missing key BLOCKS (throws 409)
// rather than returning a default. Use this for any generation/computation whose
// inputs must be governance-confirmed before it may run.
async function getRequired(companyId, key, exec = null) {
  const v = await getConfig(companyId, key, null, exec);
  if (isPending(v)) throw new HttpError(409, `config '${key}' is pending governance (registry-gated)`);
  return v;
}

async function getRequiredInt(companyId, key, exec = null) {
  return parseInt(await getRequired(companyId, key, exec), 10);
}

// Required comma-separated set (blocks on PENDING/missing).
async function getRequiredSet(companyId, key, exec = null) {
  const v = await getRequired(companyId, key, exec);
  return new Set(v.split(',').map((s) => s.trim()).filter(Boolean));
}

module.exports = {
  DEFAULT_CONFIG, SITE_SCOPE, PENDING, isPending,
  getConfig, getInt, getOwnerRoles, getRoleSet,
  getRequired, getRequiredInt, getRequiredSet,
};
