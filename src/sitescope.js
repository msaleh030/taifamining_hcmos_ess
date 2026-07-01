'use strict';
// Site-scope gate — the single, reusable server-side rule for "a site-bound role
// sees only its own site's data". It is data/config-driven (the site_scope table,
// with the seeded SITE_SCOPE defaults as a fallback), never hard-coded per screen.
//
// BINDING INVARIANT (confirmed to Design): a report/list inherits the SITE-SCOPE
// of its data. Any endpoint that returns per-employee (or per-site) records for a
// site-bound role MUST filter to the requester's site — the same way the directory
// does. This is enforced here so every consumer applies the identical rule.
//
// Used today by the Employee directory (src/employees.js). C11 Performance
// (recruitment funnel / reviews) is DEFERRED (no data model yet); when built it
// MUST route its per-site data through isScoped()/requesterSite() so a site-bound
// role (e.g. R02 Supervisor) only ever sees its own site — the gate cannot be
// re-implemented ad hoc.
const cfg = require('./config');

// Is this role site-bound? Reads the site_scope table (config), falling back to
// the seeded SITE_SCOPE defaults. `exec` must be a client already pinned to the
// tenant (RLS) — site-scope layers ON TOP of tenant isolation, never replaces it.
async function isScoped(exec, role) {
  const r = await exec.query('SELECT scoped FROM site_scope WHERE role_code=$1', [role]);
  if (r.rows[0]) return r.rows[0].scoped === true;
  return cfg.SITE_SCOPE[role] === true;
}

// The requester's own site, resolved from their employee record (RLS-scoped).
async function requesterSite(exec, session) {
  if (!session.user_id) return null;
  const r = await exec.query(
    'SELECT e.site_id FROM app_user u JOIN employee e ON e.id = u.employee_id WHERE u.id=$1',
    [session.user_id]);
  return r.rows[0] ? r.rows[0].site_id : null;
}

// Convenience: the site a site-bound role must be restricted to, or null when the
// role is central (unscoped). A consumer applies `WHERE site_id = <this>` when non-null.
async function scopeSite(exec, session) {
  if (!(await isScoped(exec, session.role_code))) return null;
  return requesterSite(exec, session);
}

module.exports = { isScoped, requesterSite, scopeSite };
