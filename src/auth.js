'use strict';
// Authentication & access service. Each function maps to an Acceptance Criterion;
// HTTP wiring lives in server.js.
const db = require('./db');
const cfg = require('./config');
const roles = require('./roles');
const C = require('./crypto');
const { HttpError, genericAuthError } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
const future = (ts) => ts && new Date(ts).getTime() > Date.now();

// ── AUTH-01/03/04/06: console sign-in (email + password + MFA) ─────────────
async function consoleLogin({ email, password, mfa }) {
  if (!email || !password || !mfa) throw genericAuthError();

  const r = await db.query('SELECT * FROM auth_lookup_console($1)', [email]);
  const u = r.rows[0];
  if (!u) throw genericAuthError();                       // unknown email
  if (u.company_status !== 'active') throw genericAuthError();
  if (future(u.locked_until)) throw genericAuthError();   // AC-AUTH-03: still locked

  // Verify ALL THREE factors; status must be active (terminated/suspended refused).
  const ok = u.status === 'active'
    && C.verifySecret(password, u.password_hash)
    && C.verifyTotp(mfa, u.mfa_secret);

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
  if (d.user_status === 'terminated') throw genericAuthError(); // terminated refused
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
    c.query('SELECT 1 FROM app_user WHERE id=$1', [target_user]));
  if (exists.rows.length === 0) throw new HttpError(404, 'not found');

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

// A3 confidential-field enforcement on profile reads (server-side).
async function readProfile(session, employeeId) {
  if (!isUuid(employeeId)) throw new HttpError(400, 'invalid request');
  const r = await db.withTenant(session.company_id, (c) =>
    c.query('SELECT * FROM employee WHERE id=$1', [employeeId]));
  if (r.rows.length === 0) throw new HttpError(404, 'not found');
  return roles.visibleProfile(session.role_code, r.rows[0]);
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
  consoleLogin, fieldLogin, verifySession,
  resetPassword, resetPin, landing, readProfile, performAction,
};
