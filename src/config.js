'use strict';
// Runtime configuration lives in the `config` table, per tenant — NEVER in code.
// These are the DEFAULT values seeded for a tenant. Two categories of not-yet-
// client-confirmed values:
//   • APPLIED, pending ratification — a real value applies now and is on the
//     ratify-at-UAT list (e.g. the DA-2 notify roles, and auth lockout). These
//     are NOT gated: they are the values, subject to confirmation, not blanks.
//   • [TBC]-gated — the PENDING sentinel; any code path that needs one BLOCKS
//     rather than defaulting (governance-critical unknowns).
// Every value is read from `config` at request time so it can change without a
// deploy — none of this is hard-coded policy.
const { query } = require('./db');
const { HttpError } = require('./errors');

// Sentinel for a registry key whose value is confirmed-PENDING governance. It is
// stored explicitly (so the key EXISTS in the registry and is auditable) but any
// code path that needs it must BLOCK — never silently default. Empty string is
// treated the same way by the required-value accessors below.
const PENDING = '__TBC__';

const DEFAULT_CONFIG = {
  // Auth lockout — APPLIED default (5 attempts / 15 min), pending client
  // ratification at UAT. Same category as the other Applied access refinements
  // (e.g. DA-2 notify roles): a real value that applies now, NOT [TBC]-gated —
  // auth cannot gate a login on a pending value. Overridable per tenant in config.
  'auth.lockout.threshold': '5',     // failed attempts before lock
  'auth.lockout.duration':  '900',   // lock seconds (15 min)

  // MFA (TOTP) on the CONSOLE login — the SINGLE reversible toggle that flips
  // BOTH the login MFA field's visibility (via GET /auth/config, read by the
  // login UI) AND server-side enforcement (consoleLogin) together. Default '1'
  // = field shown + enforced (AUTH-01 three-factor, the permanent posture).
  // Setup phase sets it to '0' on the box = field HIDDEN + NOT enforced. UAT
  // WEEK MUST flip it back to '1' — a half-flip is impossible because both the
  // field and enforcement read THIS one key. Never affects field/PIN (ESS-only).
  'auth.mfa.required':      '1',

  // session lifetime
  'session.ttl':            '3600',  // console session seconds (1 h)
  'session.field.ttl':      '43200', // field/kiosk session seconds (12 h shift)

  // [TBC] permitted owners for credential operations (role lists)
  'password.reset.owner':       'R03,R12', // HR Officer, System Admin
  'pin.reset.owner':            'R03,R12', // [TBC] device-enrolment/PIN owner
  // Role rank lattice (bughunt-B #3): a credential reset may only TARGET a role
  // at or below the actor's rank — an R03 HR Officer must never take over an
  // R12 System Administrator / executive account. Registry-overridable.
  // Super-admin split (Kira 2026-07-13): R12 System Administrator sits at 60 —
  // the IT tier, above site managers (50), BELOW the people-data tier (70) —
  // and Super Admin ranks via the app_user.is_super_admin COLUMN at
  // auth.super.rank, never via a role code. Migration 032 rewrote live rows.
  'auth.role.rank': 'R01:10,R13:10,R08:20,R09:20,R10:20,R02:30,R03:30,R05:30,R04:50,R06:50,R07:50,R12:60,R11:70,R14:70,R15:70,R16:70',
  'auth.super.rank': '100',
  'device.reenrolment.owner':   'R12',     // [TBC] new phone / replaced kiosk

  // default role for a field session when the device's employee has no app_user
  'field.default.role':     'R13',

  // ── Slice 2: Employee Master ──────────────────────────────────────────────
  // A3 confidential-field visibility (role lists). [TBC] 4 July: +R11
  // medical — kept OUT by default (conservative least privilege), flip in config.
  // v1.5 LI-3: R09 removed; Finance Manager (R15) + CFC (R16) see pay/bank.
  'a3.pay.roles':          'R07,R11,R15,R16',
  // v1.5 LI-5 (OPEN): R03 added (HR Officer absorbs clinic/medical), R10 removed.
  'a3.medical.roles':      'R03,R06',      // v1.6: R05 absorbed by R06 (SHEQ Manager)
  'a3.disciplinary.roles': 'R06,R07,R11',  // v1.6: R05 absorbed by R06
  'a3.national_id.roles':  'R03,R04,R07,R11', // Kira 2026-07-09: core HR identifier — HR-visible, NOT pay-gated (tin/bank stay pay)

  // Roles with NO directory access at all (server returns 403 on /employees*).
  // v1.5: R08/R09 retired; the finance class (R15/R16) stays directory-denied
  // like its predecessors (finance manages money, not people). Confirm at UAT.
  'directory.deny.roles':  'R12,R13,R15,R16',

  // Wave 5 — strictly READ-ONLY roles: barred at the HTTP layer from every
  // mutating route (POST/PUT/PATCH/DELETE), structurally, regardless of a
  // route's own guards. The CEO/Executive (R14) is oversight-only. The ONE
  // deliberate exception is a route flagged `readonlyOk` (R14's config-pinned
  // expatriate field-change decision) — remove R14 from expat.checker.roles to
  // strip that too, pending sign-off.
  'auth.readonly.roles':   'R14',

  // ── Disciplinary (Slice 4, SoD matrix per registry RTL/CR/TM/001/2026) ────
  // Issuer and checker role-sets are DISJOINT, so a permitted issuer and a
  // permitted checker are always different roles (SoD by construction); the
  // service additionally enforces different persons and subject ≠ actor.
  'disciplinary.issuer.roles':  'R02,R06',       // supervisor + SHEQ issue (R05 absorbed, v1.6)
  'disciplinary.checker.roles': 'R04,R11',       // HR Manager / HR Director confirm
  'disciplinary.hr.role':       'R04',           // HR named on the console notification

  // Maker-checker: who may propose / approve a change, per editable field.
  // Generic fallback applies when a field-specific key is absent.
  // R11 is a maker since the expat ruling (Kira 2026-07-12): only the Head of
  // HR may CRUD an is_expat employee, so R11 must be able to RAISE changes.
  'field_change.makers':         'R02,R03,R04,R11',
  'field_change.checkers':       'R03,R04,R11',
  'field_change.makers.phone':   'R02,R03,R04,R11',
  'field_change.checkers.phone': 'R03,R04,R11',

  // Directory paging — server-side bound; first page must not full-table scan.
  'employees.page_size':   '50',
  'employees.page_max':    '200',

  // ── Slice 3: Employee-number scheme — TMCL-<LOC>-<SEQ> ─────────────────────
  // Format is prefix + location code + per-location zero-padded sequence, no year
  // segment. Everything below is config: the generator/validator (src/empno.js)
  // hard-codes none of it.
  // prefix/width/enum + Nyanzaga=NZ pinned by test/empno.test.js (format regex
  // ^TMCL-(HO|MW|NM|NZ)-\d{4}$, NZ generation, out-of-enum rejection). The regex
  // also proves there is no company segment in the string (empno.company_segment).
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
  // v1.5 LR-4/LR-8/LR-9 — the GOING-FORWARD carry rule (REPLACES the flat
  // one-year lapse): cap carried annual leave at cap_days at each employment
  // anniversary; forfeit unused carry at anniversary + grace_months. The opening
  // bucket is exempt (OB-5). POLICY VALUES pinned by test/leave.test.js — do not
  // change without Kira.
  'leave.carry.cap_days':     '10',        // LR-8 cap at anniversary
  'leave.carry.grace_months': '3',         // LR-9 use-it-or-lose-it window
  'leave.max_continuous_days':'14',        // LR-5 max 14 continuous (HoH override, pinned by test/f3.test.js)
  'leave.entitlement.default':'21',        // LR-1 entitlement map (default grade)
  // LR-2 CONFIRMED (v1.4): entitlement WEEKS convert to real days at 7 CALENDAR
  // days/week (LR-1's 4 weeks = 28 days, 2 weeks = 14). This is a calendar
  // conversion — NOT the pay divisor. The "30" (monthly amount → daily value)
  // is a DIFFERENT conversion and lives ONLY in the daily-rate/liability path
  // (payroll.daily_rate.divisor). The two must never be collapsed: using 30 here
  // would over-credit every entitlement by ~2 days/week. Both values pinned:
  // test/f3.test.js (LR-2 weeks→days 2→14/4→28) and test/payroll.test.js (PC-1=30).
  'leave.weeks_to_days':      '7',         // LR-2 (weeks → days; 7 days/week)
  // LR-6 coverage floor (Kira, 2026-07-07): at least ONE person must remain on
  // site per role before the system warns an approver — i.e. warn when an
  // approval would leave a role at a site with zero present. 'default' applies
  // to any role without its own entry; per-role values from Omid/Baraka layer
  // on via registry edit (e.g. 'default:1,R13:5'), no deploy.
  'leave.coverage.thresholds':'default:1', // LR-6 global floor; warn-not-block
  // LR-7 CONFIRMED (v1.4): sick leave = 63 days full pay + 63 days half pay
  // (126 total); a medical certificate is required from day one. full/half is a
  // PAY split; both count against the 126-day entitlement. Pinned by
  // test/f3.test.js (sick card entitlement 126, 63/63, cert_from_day 1).
  'leave.sick.rule':          'full:63,half:63,cert_from_day:1', // LR-7

  // ── Payroll (PC-*) ────────────────────────────────────────────────────────
  // PC-1 daily-rate divisor = 30 (registry). THE pay daily-rate basis, used by
  // payroll AND by leave pay/liability. There is no 31 divisor. Value pinned by
  // test/payroll.test.js ('PC-1 daily rate uses the registry divisor (30);
  // nothing computes on 31'); a 31-day proration would be its own registry item.
  'payroll.daily_rate.divisor':'30',
  'payroll.fixed_allowances': 'house,transport,responsibility', // PC-1 fixed-allowance set
  'payroll.gross_components': 'house,transport,responsibility', // PC-3 (must equal PC-1's set)
  'payroll.partial_period':   PENDING,     // PC-2 [TBC]

  // ── Terminal / severance dues (Wave 7) — STATUTORY BASIS GOVERNANCE-GATED ───
  // TD-1: the days of basic wage payable per COMPLETED year of service is a legal
  // value (ELRA / the client's terms) that MUST be confirmed in the registry,
  // never guessed — a severance figure is too consequential to invent. It ships
  // PENDING, so terminal.severanceFor and GET /liability/terminal/:batch BLOCK
  // with 409 until Kira/Omid confirm it. Service length derives from
  // employee.joined_at; the daily basic reuses the SAME PC-1 base (exact.
  // dailyRateBase) and divisor as payroll and leave liability — ONE base.
  'terminal.severance.days_per_year': PENDING,   // TD-1 [TBC]
  'terminal.min_service_years':       '1',       // qualifying threshold — confirm at UAT

  // ── Geofence clock-in (SS-3, registry v1.4 CONFIRMED) ─────────────────────
  // Zones themselves live in geofence_zone (per site). These tune the validator.
  // CONFIRMED: accept when distance <= radius + min(device_accuracy, 50m). The
  // 50m tolerance and the 100m retry threshold below are pinned by test/f5.test.js
  // (ATT-03 tolerance-accepts-near-boundary / accuracy>100→retry).
  'geofence.tolerance.policy':  'accuracy',  // accuracy | none
  'geofence.tolerance.max_m':   '50',
  // CONFIRMED: above this reported accuracy the fix is too coarse to trust — the
  // clock-in is neither accepted nor rejected; the caller is asked to retry.
  'geofence.accuracy.retry_above_m': '100',
  // Defensive: a site with NO zones does not hard-reject (HO now has a zone, so
  // this no longer applies to HO; kept for any unmapped site). 'allow' | 'reject'.
  'geofence.empty_zone.policy': 'allow',

  // ── Exact payroll ingestion (Slice 8; contract v2.0 = OFFICIAL export) ────
  // The EX-* values below are pinned by test/exact.test.js and test/f6.test.js
  // (schema validation, EX-1 legacy_id match, EX-3 per-row net == col 44, EX-2
  // name-keyed base). A wrong column index fails those tests, not just this note.
  // v2.0 (2026-07-14, header-map probe run 29331947385): the official Exact
  // export is 49 columns with headers on ROW 1 — no title band, no section row.
  // The v1.2 registry-appendix grid never matched it (Correction 1 made that
  // loud); v1.2 remains seeded for historical batches only.
  'exact.contract.version': 'v2.0',
  'exact.section_row':      '1',   // single-row header: no section band in the
  'exact.header_row':       '1',   // official export; both point at row 1
  // EX-1 CONFIRMED: match Exact rows on legacy_id (old master-file ID), NOT
  // emp_no/TMCL. New joiners with only a TMCL number surface as unmatched.
  'exact.match.key':        'legacy_id',
  // GROSS: 'Total Allowances' at 27 (basic + ALL earnings incl. Overdraft,
  // ruled an EARNING 2026-07-14). Identity: net = gross + roundup − deductions
  // − rounddown; pinned against the North Mara period in test/exact.test.js.
  'exact.col.gross':           '27',
  'exact.col.total_deduction': '42',
  // Round-up / round-down positions — EVIDENCED by the header-map probe
  // ('Cent Round Up' 28, 'Cent Round Down' 43); the ex-[TBC] is closed.
  'exact.col.roundup':         '28',
  'exact.col.rounddown':       '43',
  // EX-3 CONFIRMED: 'Net Payment' is column 44 = gross + ru − ded − rd.
  'exact.netpay.source':    'col:44',
  // EX-2 daily-rate base — NAME-KEYED (resolved to positions via the column
  // contract), so a column can never silently drift. This is the single base
  // used by payroll and by leave pay/liability.
  // RATIFIED (Kira 2026-07-14, official NM export, 285 rows / 231 complete):
  // exactly SIX base components — the Fixed housing/transport columns, never
  // the Variable ones; MEDICAL was a phantom and is gone.
  // CORRECTION 1 (Kira 2026-07-14): every name below resolves by EXACT,
  // CASE-INSENSITIVE match on the literal header — no substrings, no
  // abbreviations, no whitespace tidying — and a name resolving to zero or
  // several contract columns HARD-BLOCKS the ingest (src/exact.js).
  'exact.dailyrate.include_names': 'Basic Salary,Fixed Overtime,Project Allowance,Responsibility Allowance,Housing Allowance (Fixed),Transport Allowance(Fixed)',
  // Kira ruling 2026-07-14: ALL cent-round columns are EXCLUDED from the
  // leave-pay base — a rounding carry is not earned pay. They live in the Net
  // formula (Net = Total Allowances − Total Deductions + Cent Round Up − Cent
  // Round Down), never the base. Byte-identical contract headers: 25, 28, 41, 43.
  'exact.dailyrate.exclude_names': 'Rotation Allowance,Night Allowance,Overtime - Normal Days,Overtime - Holidays,Transport Allowance(variable),House Allowance(Variable),Gross Salary Arrears,Terminal Dues,Overdraft,Previous Cent-Round Deduction,Cent Round Up,Cent Round Down,Previous Cent-Round Payment',
  // PENDING CECILIA (do not guess): money in these components blocks the figure,
  // NAMING them. Impact at 20 days outstanding ≈ TZS 3.7M across 231 people.
  'exact.dailyrate.pending_names': 'Local Conveyance,TSF Allowance',
  // The GROSS/TOTAL earnings column — a total, never a base component.
  'exact.dailyrate.gross_name': 'Total Allowances',
  // EX-2 governance gate (Kira 2026-07-14): the leave-pay/liability figure is
  // fail-closed — NOT AVAILABLE — until Cecilia RATIFIES the pay-component
  // classification (rotation/night-shift/variable-overtime excluded; the
  // unclassified North Mara components ruled). Set to 'true' only on her sign-off.
  'exact.dailyrate.classification.ratified': PENDING,
  // Full-period control-totals reconciliation (AC-EXACT-07) — still gated until a
  // real populated period arrives; the per-row net check runs now (EX-3).
  'exact.reconciliation':   PENDING,

  // ── Documents / retention / region (DA-1, AC-2) ──────────────────────────
  'doc.lead_time.contract':   '30',        // DA-1 lead times (days)
  'doc.lead_time.permit':     '60',
  'doc.lead_time.licence':    '45',
  'doc.lead_time.medical':    '30',
  // DA-2 notified role per document type — THREE-WAY split RATIFIED by Kira
  // (2026-07-06): expat/immigration permits are SENSITIVE and scoped to the
  // Head of HR ALONE (visibility + notification); business permits/licences to
  // the SHEQ Manager; medical to the HR Officer OF THE EMPLOYEE'S SITE (the
  // site match is routing semantics in src/docalerts.js — the registry key
  // holds the role). A permit with no expat/business classification is NEVER
  // guessed: it fails CLOSED to the R11 leg, flagged `unclassified`.
  // Contract expiries split expat-vs-local (Kira, 2026-07-06 — supersedes the
  // R06 inference): an expatriate's contract expiry is as sensitive as their
  // permit (Head of HR ONLY); a local's goes to the HR Officer OF THEIR SITE.
  'doc.notify.role.contract.expat':  'R11', // expat contract — Head of HR ONLY
  'doc.notify.role.contract.local':  'R03', // local contract — SITE-MATCHED HR Officer
  'doc.notify.role.permit.expat':    'R11', // expat/immigration — Head of HR ONLY (Kira, 2026-07-06)
  'doc.notify.role.permit.business': 'R06', // business permits — SHEQ Manager (unchanged leg)
  'doc.notify.role.licence':         'R06', // business licences — SHEQ Manager (unchanged leg)
  'doc.notify.role.medical':         'R03', // HR Officer — SITE-MATCHED to the employee (Kira, 2026-07-06)
  // Expatriate record CRUD (Kira, 2026-07-12): STRICTLY the Head of HR. Any
  // application mutation of an is_expat employee — maker submit AND checker
  // decision — requires a role in this set, and their permit documents are
  // visible only to it (the DA-2 R11-only leg extended to the document list).
  // The bulk ingest pipeline (R15 maker / R16 checker, control-totalled) is
  // the ONE sanctioned load path and is not an interactive CRUD surface.
  'expat.crud.roles':                'R11',
  // Expatriate field-change MAKER (Kira, 2026-07-14): site HR raises the change.
  'expat.maker.roles':               'R03',
  // Expatriate field-change maker-checker (Kira, 2026-07-14 — supersedes the
  // 2026-07-12 R14 ruling): MAKER = R03 (site HR) raises, CHECKER = R11 (Head of
  // HR) decides. The CEO (R14) is read-only everywhere and is NO LONGER a
  // checker. SoD does not dead-end: maker (R03) ≠ checker (R11).
  'expat.checker.roles':             'R11',
  // ── Shared KIOSK (Kira rulings 2026-07-14) ────────────────────────────────
  // A kiosk session exists for ONE punch: short TTL + revoked on punch.
  'kiosk.session.ttl':        '120',
  // Punch photos: BINARY ON DISK outside the deploy tree (path in the DB,
  // never base64). Production object storage is a flagged Kira decision.
  'attendance.photo.dir':     '/var/lib/hcmos/punch-photos',
  // Second factor on the shared device (the buddy-punching seam): 'photo' =
  // photo-on-punch (ruled 2026-07-14; records, never blocks). A stronger
  // factor later slots in at kiosk.kioskLogin without touching the punch path.
  'kiosk.second_factor':      'photo',
  // Support ticket channels (ES-5).
  'support.channels':         'in_app,email',
  // ── F7 guards (Slice 9 modules exposed over HTTP). All four are APPLIED,
  //    pending client ratification at UAT (same category as DA-2 roles / lockout):
  //    real values that apply now, NOT [TBC]-gated. Each guard is pinned by a test.
  //
  // Document-expiry alerts → document-compliance owners: the DA-2 notified roles
  // (R03/R06 after v1.6) + the HR line and admin oversight. DELIBERATELY not
  // reports-scoped: R03 (HR Officer, a DA-2 recipient since v1.5) has no reports
  // module, so a reports guard would wrongly exclude a DA-2 recipient. UAT:
  // faithful-rule-correct as-is; ratify. Pinned by test/f7.test.js.
  'alerts.view.roles':        'R03,R04,R06,R11,R12', // v1.6: R05 absorbed by R06
  // Opening-Balance & Document Ingestion — the HIGHEST-privilege load path (it
  // writes the owed numbers). v1.5 LI-6: the maker/checker split is a REAL SoD
  // control on DISJOINT roles (the disciplinary issuer/checker pattern):
  //   maker (submit)  = Finance Manager (R15) — operates the ingestion;
  //   checker (approve)= Chief Financial Controller (R16) — approves the commit;
  // plus the same-user-403 rule on top. ingest.roles is the UNION (the endpoint
  // gate); the per-leg sets are enforced in the service. POLICY VALUES pinned by
  // test/ingest.test.js + test/roles_v15.test.js; do not change without Kira.
  'ingest.roles':             'R15,R16',
  'ingest.maker.roles':       'R15',
  'ingest.checker.roles':     'R16',
  // Controls & Checker / audit view — the AUD/SOD oversight set: HR Director
  // (R11, exec oversight) + System Administrator (R12). No one else reads the
  // SoD-breach / leaver-access / audit-chain evidence. UAT: confirm AUD/SOD
  // membership (R11/R12 applied; org RACI may add/replace). Pinned: test/f7_controls.test.js.
  'controls.view.roles':      'R11,R12',
  // Support helpdesk agents — may view and drive the lifecycle of ANY ticket. A
  // raiser always sees/acts on their OWN ticket regardless (record-scoped in the
  // service). Applied: System Admin only to start. UAT: confirm R12-only vs an
  // HR / dedicated support owner. Pinned by test/f7.test.js.
  'support.agent.roles':      'R12',
  // Policy PUBLISH (POL-01) — who may publish a company-wide policy version.
  // Applied: System Admin (R12). Read + acknowledge (POL-02/03) are self-service;
  // the outstanding-acks report (POL-04) is module:'reports'. UAT: confirm the
  // publish owner is IT-admin (R12) vs HR (R07) — org RACI may differ; flipping it
  // is a registry edit, not a code change. Pinned by test/f7.test.js.
  'policy.publish.roles':     'R12',
  'retention.audit_years':    '7',
  'retention.safety_years':   '10',
  'region':                   'af-south-1',

  // ── Analytics scorecard (Slice 7, KPI) ────────────────────────────────────
  // Steering decision: the org KPI scorecard is active only if the client buys
  // analytics. The engine + personal My KPIs (E8) exist regardless.
  'analytics.enabled':        'false',

  // ── Pending governance refinements (registered so they are gated, not silently
  //    defaulted; nothing reads these until a value is set) ───────────────────
  'pending.a3.r11_medical':   PENDING,     // A3: R11 CEO medical
  'jml.probation':            PENDING,     // JML-3 [TBC]
  'es.reenrolment.owner':     PENDING,     // ES-1 device re-enrolment owner [TBC]
  'es.channels':              PENDING,     // ES-4 [TBC]
  'asset.owner.role':         PENDING,     // [TBC]
  'competency.steps':         PENDING,     // [TBC]
};

// Site-scope is data/config (the site_scope table), not hard-coded. These are
// the seeded defaults. R05 removed at the app layer (v1.6 — absorbed by R06);
// its row stays only so historical R05 rows keep a defined scope.
const SITE_SCOPE = {
  R01: true,  R02: true,  R03: true,  R05: true,
  R04: false, R06: false, // HR Manager + SHEQ Manager — 'All sites' (Kira 2026-07-12)
  R07: false, R11: false, R12: false, R13: false,
  R15: false, R16: false, // finance roles — central (v1.5)
  R14: false, // CEO/Executive — org-wide oversight, never site-scoped (v1.5)
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
  if (v === null) return fallback;
  const n = parseInt(v, 10);
  // bughunt-B #13: '' / [TBC] / garbage must yield the FALLBACK, never NaN — a
  // NaN here silently disables numeric gates (e.g. the lockout counter).
  return Number.isFinite(n) ? n : fallback;
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

// Required POSITIVE integer — 409 on zero/negative/non-numeric (bughunt-B #9).
// Guards divide-by values (payroll.daily_rate.divisor): a 0 must BLOCK the
// computation, never produce Infinity in pay math.
async function getRequiredPositiveInt(companyId, key, exec = null) {
  const n = await getRequiredInt(companyId, key, exec);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HttpError(409, `${key} is not a positive integer — computation blocked`, { key, value: n });
  }
  return n;
}

// Required comma-separated set (blocks on PENDING/missing).
async function getRequiredSet(companyId, key, exec = null) {
  const v = await getRequired(companyId, key, exec);
  return new Set(v.split(',').map((s) => s.trim()).filter(Boolean));
}

module.exports = {
  DEFAULT_CONFIG, SITE_SCOPE, PENDING, isPending,
  getConfig, getInt, getOwnerRoles, getRoleSet,
  getRequired, getRequiredInt, getRequiredPositiveInt, getRequiredSet,
};
