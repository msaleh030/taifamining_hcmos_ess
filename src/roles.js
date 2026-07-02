'use strict';
// Single source of truth for role-driven access (Addenda A1/A2/A3).
//
// ── IMPORTANT (A2 landing) ─────────────────────────────────────────────────
// The authoritative R01..R13 landing/module set is encoded in the approved
// design `HCMOS Auth Flow.html` ROLES table. That design file was NOT delivered
// into this repo, so the LANDING map below is a documented, least-privilege
// DERIVATION to be reconciled against the design before launch. The *mechanism*
// — server-side enforcement, least privilege, no link to a forbidden area — is
// final and tested; only the specific module-per-role rows are provisional.
//
// The A3 confidential-field rules and the principle that forbidden fields are
// OMITTED (absent, not masked) ARE specified in the Acceptance Pack and are
// encoded here exactly.

// Catalogue of modules an authenticated principal may land on.
const MODULES = [
  'dashboard', 'profile', 'leave', 'timesheet', 'training', 'performance',
  'recruitment', 'payroll', 'finance', 'health_safety', 'medical', 'permits',
  'disciplinary', 'reports', 'admin', 'field_ops',
];

// R01..R13 -> { name, modules }. Least privilege: a role sees only its modules.
const LANDING = {
  R01: { name: 'Employee (Self-Service)', modules: ['dashboard', 'profile', 'leave', 'timesheet', 'training'] },
  R02: { name: 'Supervisor',              modules: ['dashboard', 'profile', 'leave', 'timesheet', 'performance', 'reports'] },
  // v1.5 LI-2: HR Officer ABSORBS clinic/medical administration (R10 removed) —
  // hence health_safety/medical/permits. Flagged for design reconciliation at UAT.
  R03: { name: 'HR Officer',              modules: ['dashboard', 'profile', 'leave', 'recruitment', 'training', 'health_safety', 'medical', 'permits'] },
  R04: { name: 'HR Manager',              modules: ['dashboard', 'profile', 'leave', 'recruitment', 'training', 'performance', 'reports'] },
  R05: { name: 'HSE Officer',             modules: ['dashboard', 'health_safety', 'permits', 'disciplinary', 'reports'] },
  R06: { name: 'HSE / Medical Manager',   modules: ['dashboard', 'health_safety', 'permits', 'medical', 'disciplinary', 'reports'] },
  R07: { name: 'Payroll Officer',         modules: ['dashboard', 'payroll', 'disciplinary', 'reports'] },
  // R08 (Finance Officer) + R09 (Payroll Manager) REMOVED — registry v1.5 LI-3:
  // merged into R15 Finance Manager; R16 CFC added as the senior approver.
  // R10 (Clinic / Medical Staff) REMOVED — registry v1.5 LI-2: Taifa has no
  // separate clinic staff; HR Officer (R03) absorbs clinic/medical administration.
  R11: { name: 'HR Director',             modules: ['dashboard', 'profile', 'payroll', 'performance', 'disciplinary', 'reports'] },
  R12: { name: 'System Administrator',    modules: ['dashboard', 'admin', 'reports'] },
  R13: { name: 'Field Operator',          modules: ['field_ops', 'timesheet'] },
  // v1.5: CEO / Executive — READ-ONLY organisation-wide oversight (all sites, not
  // site-scoped). Deliberately NOT in ACTIONS (no admin/payroll/approve powers)
  // and NOT in FIELD_RULES.pay_grade/bank_account: per LI-4 (pending confirm) the
  // CEO sees aggregates/reports, NOT individual pay — pinned by test; do not add
  // pay visibility without Kira. Flagged for design reconciliation at UAT.
  R14: { name: 'CEO / Executive',         modules: ['dashboard', 'reports'] },
  // v1.5 LI-3/LI-6: Finance Manager OPERATES payroll + opening-balance ingestion
  // (the MAKER); the Chief Financial Controller APPROVES the ingestion commit
  // (the CHECKER). Disjoint maker/checker roles = SoD by construction (the same
  // pattern as disciplinary issuer/checker); the same-user-403 rule still applies
  // on top. Both see pay/bank. Flagged for design reconciliation at UAT.
  R15: { name: 'Finance Manager',         modules: ['dashboard', 'finance', 'payroll', 'reports'] },
  R16: { name: 'Chief Financial Controller', modules: ['dashboard', 'finance', 'payroll', 'reports'] },
};

// A3 confidential profile fields -> roles permitted to SEE them. Any field not
// permitted for the viewer's role is omitted from the response entirely.
const FIELD_RULES = {
  // v1.5 LI-3: pay/bank = Payroll Officer, Finance Manager, CFC, HR Director.
  // R09 removed; CEO (R14) and HR Officer (R03) deliberately NOT added — pinned
  // by test/roles_v15.test.js.
  pay_grade:    ['R07', 'R11', 'R15', 'R16'],   // pay/bank
  bank_account: ['R07', 'R11', 'R15', 'R16'],   // pay/bank
  // v1.5 LI-5 (OPEN — held for Kira's ratify): R03 added because HR Officer now
  // does clinic/medical administration. This WIDENS medical visibility to all HR
  // Officers — a confidentiality-boundary change, pinned by test/roles_v15.test.js.
  medical_notes:['R03', 'R05', 'R06'],   // medical/permits (R10 removed, v1.5)
  permits:      ['R03', 'R05', 'R06'],   // medical/permits (R10 removed, v1.5)
  disciplinary: ['R05', 'R06', 'R07', 'R11'],
};

// Always-visible, non-confidential profile fields.
const PUBLIC_PROFILE_FIELDS = ['id', 'full_name'];

// Server-side RBAC action matrix. The UI never offers an action a role lacks,
// but the server is the control: every action is checked here regardless of UI.
// `admin.*` actions are R12-only — used by the Section 17 RBAC test.
const ACTIONS = {
  'admin.config.write':  ['R12'],
  'admin.user.suspend':  ['R12'],
  'admin.tenant.manage': ['R12'],
  // v1.5 LI-6: payroll is RUN by finance (Finance Manager + CFC). R09 removed;
  // R12 (System Admin) deliberately REMOVED — admin must not run payroll. Pinned.
  'payroll.run':         ['R15', 'R16'],
  'leave.approve':       ['R02', 'R04', 'R11'],
};

function landingFor(role) {
  const l = LANDING[role];
  if (!l) return { role, name: 'Unknown', modules: [] };
  return { role, name: l.name, modules: [...l.modules] };
}

function moduleAllowed(role, module) {
  return !!LANDING[role] && LANDING[role].modules.includes(module);
}

function canPerform(role, action) {
  const allowed = ACTIONS[action];
  if (!allowed) return false; // unknown action -> deny by default
  return allowed.includes(role);
}

// Build a profile response containing ONLY the fields the viewer's role may see.
// Forbidden confidential fields are absent (not masked / not null-padded).
function visibleProfile(viewerRole, employeeRow) {
  const out = {};
  for (const f of PUBLIC_PROFILE_FIELDS) {
    if (employeeRow[f] !== undefined) out[f] = employeeRow[f];
  }
  for (const [field, roles] of Object.entries(FIELD_RULES)) {
    if (roles.includes(viewerRole) && employeeRow[field] !== undefined && employeeRow[field] !== null) {
      out[field] = employeeRow[field];
    }
  }
  return out;
}

module.exports = {
  MODULES, LANDING, FIELD_RULES, ACTIONS,
  landingFor, moduleAllowed, canPerform, visibleProfile,
};
