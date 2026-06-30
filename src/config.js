'use strict';
// Runtime configuration lives in the `config` table, per tenant — NEVER in code.
// These are the DEFAULT values seeded for a tenant. The [TBC] items (lockout
// policy, enrolment/PIN-reset owners) are pending the 4 July governance return;
// they are read from `config` at request time so they can change without a
// deploy. The values here are defensible defaults, not hard-coded policy.
const { query } = require('./db');
const { HttpError } = require('./errors');

// Sentinel for a registry key whose value is confirmed-PENDING governance. It is
// stored explicitly (so the key EXISTS in the registry and is auditable) but any
// code path that needs it must BLOCK — never silently default. Empty string is
// treated the same way by the required-value accessors below.
const PENDING = '__TBC__';

const DEFAULT_CONFIG = {
  // [TBC] auth lockout policy
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
  'leave.weeks_to_days':      PENDING,     // LR-2 [TBC]
  'leave.coverage.thresholds':PENDING,     // LR-6 [TBC] per-role coverage
  'leave.sick.rule':          PENDING,     // LR-7 [TBC]

  // ── Payroll (PC-*) ────────────────────────────────────────────────────────
  'payroll.daily_rate.divisor':'31',       // PC-1 [FLAGGED: confirm with Finance]
  'payroll.fixed_allowances': 'house,transport,responsibility', // PC-1 fixed-allowance set
  'payroll.gross_components': 'house,transport,responsibility', // PC-3 (must equal PC-1's set)
  'payroll.partial_period':   PENDING,     // PC-2 [TBC]

  // ── Geofence clock-in (SS-3) ──────────────────────────────────────────────
  // Zones themselves live in geofence_zone (per site). These tune the validator.
  // [OPEN] HO has no zones: interim 'allow' so an empty zone set does NOT reject
  // (HO staff are not locked out); flip to 'reject' once the HO decision lands.
  'geofence.empty_zone.policy': 'allow',
  // [FLAGGED: confirm tolerance policy] accept when distance <= radius + accuracy,
  // with accuracy capped at tolerance.max_m to bound spoofed-accuracy abuse.
  'geofence.tolerance.policy':  'accuracy',  // accuracy | none
  'geofence.tolerance.max_m':   '50',

  // ── Documents / retention / region (DA-1, AC-2) ──────────────────────────
  'doc.lead_time.contract':   '30',        // DA-1 lead times (days)
  'doc.lead_time.permit':     '60',
  'doc.lead_time.licence':    '45',
  'doc.lead_time.medical':    '30',
  'doc.notify.role':          PENDING,     // DA-1 notified role per doc type [TBC]
  'retention.audit_years':    '7',
  'retention.safety_years':   '10',
  'region':                   'af-south-1',

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
