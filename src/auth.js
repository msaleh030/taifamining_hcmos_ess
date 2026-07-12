'use strict';
// Authentication & access service. Each function maps to an Acceptance Criterion;
// HTTP wiring lives in server.js.
const db = require('./db');
const cfg = require('./config');
const roles = require('./roles');
const a3 = require('./a3');
const sitescope = require('./sitescope');
const C = require('./crypto');
const { HttpError, genericAuthError } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
const future = (ts) => ts && new Date(ts).getTime() > Date.now();

// ── AUTH-01/03/04/06: console sign-in (email + password + MFA) ─────────────
// MFA (TOTP) is required unless the tenant explicitly disables it with config
// `auth.mfa.required=0` — a UAT/CRP convenience only. The default keeps
// AUTH-01's three-factor rule, so tenants are unchanged unless deliberately set.
async function consoleLogin({ email, password, mfa }) {
  if (!email || !password) throw genericAuthError();

  const r = await db.query('SELECT * FROM auth_lookup_console($1)', [email]);
  const u = r.rows[0];
  // Always spend the scrypt cost, even for an unknown/inactive/locked account,
  // so login timing never reveals whether the email exists (enumeration oracle).
  const pwOk = C.verifySecret(password, (u && u.password_hash) || C.DUMMY_HASH);
  if (!u) throw genericAuthError();                       // unknown email
  if (u.company_status !== 'active') throw genericAuthError();
  if (future(u.locked_until)) throw genericAuthError();   // AC-AUTH-03: still locked

  const mfaRequired = (await cfg.getInt(u.company_id, 'auth.mfa.required', 1)) !== 0;
  if (mfaRequired && !mfa) throw genericAuthError();      // AUTH-04: never name the factor

  // Verify the factors; status must be active (terminated/suspended refused).
  // verifyTotp now accepts only the [step-1, step] window — a code from the
  // FUTURE (the old +1 step) is never valid, halving the acceptance window.
  const ok = u.status === 'active'
    && pwOk
    && (!mfaRequired || C.verifyTotp(mfa, u.mfa_secret));

  if (!ok) {
    const threshold = await cfg.getInt(u.company_id, 'auth.lockout.threshold', 5);
    const duration  = await cfg.getInt(u.company_id, 'auth.lockout.duration', 900);
    await db.query('SELECT * FROM auth_console_fail($1,$2,$3)', [u.user_id, threshold, duration]);
    throw genericAuthError();                             // AUTH-04: never name the factor
  }

  const ttl = await cfg.getInt(u.company_id, 'session.ttl', 3600);
  const token = C.newToken();
  const s = await db.query('SELECT * FROM auth_console_success($1,$2,$3)',
    [u.user_id, C.tokenHash(token), ttl]);
  const land = roles.landingFor(u.role_code);
  return {
    token,
    role: u.role_code,
    landing: land,
    route: '/' + (land.modules[0] || 'dashboard'),       // A2 landing route
    expires_at: s.rows[0].expires_at,
  };
}

// ── AUTH-02/03/04: field sign-in (device + PIN), offline-idempotent ────────
async function fieldLogin({ device_id, pin, idempotency_key }) {
  if (!isUuid(device_id) || !pin) throw genericAuthError();

  const r = await db.query('SELECT * FROM auth_lookup_device($1)', [device_id]);
  const d = r.rows[0];
  if (!d) throw genericAuthError();                       // unregistered device refused
  if (d.company_status !== 'active') throw genericAuthError();
  if (d.device_status !== 'active') throw genericAuthError();
  // A non-active app_user (suspended OR terminated) is refused — same rule the
  // console path enforces (status must be 'active'). user_status is NULL only
  // for the no-app_user field bootstrap (device maps to an employee with no
  // console account); that path is allowed and takes field.default.role.
  if (d.user_status && d.user_status !== 'active') throw genericAuthError();
  if (future(d.locked_until)) throw genericAuthError();

  if (!C.verifySecret(pin, d.pin_hash)) {
    const threshold = await cfg.getInt(d.company_id, 'auth.lockout.threshold', 5);
    const duration  = await cfg.getInt(d.company_id, 'auth.lockout.duration', 900);
    await db.query('SELECT * FROM auth_device_fail($1,$2,$3)', [device_id, threshold, duration]);
    throw genericAuthError();
  }

  const ttl = await cfg.getInt(d.company_id, 'session.field.ttl', 43200);
  const defaultRole = await cfg.getConfig(d.company_id, 'field.default.role', 'R13');
  const token = C.newToken();
  const s = await db.query('SELECT * FROM auth_field_success($1,$2,$3,$4,$5)',
    [device_id, C.tokenHash(token), ttl, idempotency_key || null, defaultRole]);
  const out = s.rows[0];

  if (out.deduped) {
    // Replay of an already-synced offline request: no new session/audit created.
    return { deduped: true, session_id: out.session_id, role: out.role_code, expires_at: out.expires_at };
  }
  const land = roles.landingFor(out.role_code);
  return {
    deduped: false,
    token,
    role: out.role_code,
    session_id: out.session_id,
    landing: land,
    route: '/' + (land.modules[0] || 'field_ops'),
    expires_at: out.expires_at,
  };
}

// PUBLIC (pre-auth) login config: tells the login UI whether to render the MFA
// field. Reads the SAME `auth.mfa.required` key that consoleLogin enforces, so
// the field's visibility and enforcement can never disagree (no half-flip).
// Pre-auth there is no tenant context, so it resolves the primary (earliest
// active) tenant — correct for the single-tenant UAT box; enforcement itself
// always stays per-tenant on the actual login. No secrets in the response.
async function publicAuthConfig() {
  // SECURITY DEFINER read (tenant is under RLS; the app role has no company
  // context pre-auth). Absent row → safe default (field shown).
  const r = await db.query('SELECT * FROM auth_public_config()');
  const mfaRequired = r.rows[0] ? r.rows[0].mfa_required !== false : true;
  return { mfaRequired };
}

// Session validation — run on every authenticated request.
async function verifySession(token) {
  if (!token) return null;
  const r = await db.query('SELECT * FROM auth_lookup_session($1)', [C.tokenHash(token)]);
  return r.rows[0] || null; // {session_id,company_id,user_id,device_id,role_code,expires_at}
}

// Resolve the acting user's email for audit, scoped to their own tenant (RLS).
async function actorEmail(session) {
  if (!session.user_id) return session.device_id ? `device:${session.device_id}` : 'unknown';
  return db.withTenant(session.company_id, async (c) => {
    const r = await c.query('SELECT email FROM app_user WHERE id=$1', [session.user_id]);
    return (r.rows[0] && r.rows[0].email) || String(session.user_id);
  });
}

// ── AUTH-05: password reset — permitted owner only; kills all sessions ─────
async function resetPassword(session, { target_user, new_password }) {
  if (!session) throw new HttpError(401, 'authentication required');
  if (!isUuid(target_user) || !new_password) throw new HttpError(400, 'invalid request');

  const owners = await cfg.getOwnerRoles(session.company_id, 'password.reset.owner');
  if (!owners.includes(session.role_code)) throw new HttpError(403, 'forbidden');

  // Target must be in the actor's tenant — RLS makes other tenants invisible.
  const exists = await db.withTenant(session.company_id, (c) =>
    c.query('SELECT role_code FROM app_user WHERE id=$1', [target_user]));
  if (exists.rows.length === 0) throw new HttpError(404, 'not found');

  // bughunt-B #3 (rank lattice): a reset may only TARGET a role at or below the
  // actor's rank. Being in password.reset.owner opens the door; it must NEVER
  // let an R03 HR Officer rotate an R12 System Administrator's / super-admin's
  // credential and take the account over. Fail closed: a role absent from the
  // lattice outranks everyone as a target.
  const ranks = new Map();
  for (const part of String(await cfg.getConfig(session.company_id, 'auth.role.rank', '') || '').split(',')) {
    const [role, n] = part.split(':').map((s) => s.trim());
    if (role && Number.isFinite(Number(n))) ranks.set(role, Number(n));
  }
  const actorRank = ranks.get(session.role_code) ?? 0;
  const targetRank = ranks.get(exists.rows[0].role_code) ?? Infinity;
  if (targetRank > actorRank) throw new HttpError(403, 'cannot reset a higher-ranked account (rank lattice)');

  const actor = await actorEmail(session);
  const res = await db.query('SELECT * FROM auth_reset_password($1,$2,$3,$4)',
    [target_user, C.hashSecret(new_password), actor, session.role_code]);
  return { ok: true, revoked_sessions: res.rows[0].revoked };
}

// ── AUTH-05: PIN reset — permitted device/PIN owner only; revokes sessions ─
async function resetPin(session, { device_id, new_pin }) {
  if (!session) throw new HttpError(401, 'authentication required');
  if (!isUuid(device_id) || !new_pin) throw new HttpError(400, 'invalid request');

  const owners = await cfg.getOwnerRoles(session.company_id, 'pin.reset.owner');
  if (!owners.includes(session.role_code)) throw new HttpError(403, 'forbidden');

  const exists = await db.withTenant(session.company_id, (c) =>
    c.query('SELECT 1 FROM device WHERE id=$1', [device_id]));
  if (exists.rows.length === 0) throw new HttpError(404, 'not found');

  const actor = await actorEmail(session);
  const res = await db.query('SELECT * FROM auth_reset_pin($1,$2,$3,$4)',
    [device_id, C.hashSecret(new_pin), actor, session.role_code]);
  return { ok: true, revoked_sessions: res.rows[0].revoked };
}

// ── AUTH-06: landing — only modules permitted for the role (A2) ────────────
function landing(session) {
  return roles.landingFor(session.role_code);
}

// A3 confidential-field enforcement on profile reads (server-side). Shares the
// Slice 2 assembler so forbidden fields are absent (table not even joined).
// This is a profile READ of an arbitrary employee id, so it MUST carry the SAME
// two access gates as GET /employees/:id (employees.get) — A3 field-gating
// alone is not enough: without them a site-bound role reads out-of-site
// profiles (incl. medical/disciplinary), and a directory-denied finance role
// reads anyone's pay/bank. Kept in lock-step with employees.js:104-118.
async function readProfile(session, employeeId) {
  if (!isUuid(employeeId)) throw new HttpError(400, 'invalid request');
  const deny = await cfg.getRoleSet(session.company_id, 'directory.deny.roles', 'R12,R13,R15,R16');
  if (deny.has(session.role_code)) throw new HttpError(403, 'forbidden');
  return db.withTenant(session.company_id, async (c) => {
    const r = await c.query('SELECT * FROM employee WHERE id=$1', [employeeId]);
    if (r.rows.length === 0) throw new HttpError(404, 'not found'); // RLS already hid other tenants
    // Site check BEFORE any confidential assembly (Section 17.2): an out-of-site
    // request 404s exactly as the directory does.
    if (await sitescope.isScoped(c, session.role_code)) {
      const mySites = await sitescope.requesterSites(c, session);
      if (!mySites.length || !mySites.includes(r.rows[0].site_id)) throw new HttpError(404, 'not found');
    }
    return a3.assembleProfile(c, session, r.rows[0]);
  });
}

// Server-side RBAC: matrix checked here regardless of what the UI offered.
async function performAction(session, action) {
  if (!roles.canPerform(session.role_code, action)) throw new HttpError(403, 'forbidden');
  await db.query('SELECT * FROM audit_append($1,$2,$3,$4,$5,$6,$7,$8)',
    [session.company_id, String(session.user_id || session.device_id), session.role_code,
     'action.' + action, 'action', action, null, null]);
  return { ok: true, action };
}

module.exports = {
  consoleLogin, fieldLogin, verifySession, publicAuthConfig,
  resetPassword, resetPin, landing, readProfile, performAction,
};
