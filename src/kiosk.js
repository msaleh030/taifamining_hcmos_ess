'use strict';
// Shared KIOSK device model (Kira rulings, 2026-07-14). One device at a site,
// many people; the PIN identifies the PERSON. Stricter than personal-phone R13
// BY DESIGN:
//   • the device enrols to a SITE, not a person (device.kind='kiosk');
//   • a kiosk session is CLOCK-IN/OUT ONLY — the scope is enforced in the
//     server guard (session.kind==='kiosk' reaches nothing else), never by UI;
//   • AUTO-LOGOUT the instant a punch commits (auth_revoke_session in the same
//     flow) — no persistence between people, no back-navigation into the
//     previous person's data;
//   • PIN + PHOTO-ON-PUNCH: the photo RECORDS, it never BLOCKS. Camera fails →
//     the punch still succeeds and the row is FLAGGED photo_missing=true (the
//     buddy-punching / camera-failure signal surfaced by C20 check 6). One
//     photo, one attendance row — no gallery, no recognition, no pooling
//     (TZ PDPA scoping; Kira is confirming the DP position separately).
//
// SECOND-FACTOR HOOK (flagged, not blocking): a PIN alone on a shared device
// is weaker than PIN+possession. The seam is `kiosk.second_factor` in config —
// 'photo' (this build) is the ruling; 'staff-number+PIN' is the picker+PIN
// flow itself; a future stronger factor slots into kioskLogin below without
// touching the punch path.
//
// STORAGE: punch photos are REAL BINARY AT SCALE (~1,000 workers, daily).
// They are written to attendance.photo.dir on the local filesystem — OUTSIDE
// the deploy tree — and the DB stores only the path. Never a base64 data URL
// in the DB. Production-scale object storage is flagged to Kira separately.
const crypto = require('node:crypto');
const db = require('./db');
const cfg = require('./config');
const C = require('./crypto');
const storage = require('./storage');
const { HttpError, genericAuthError } = require('./errors');

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const future = (ts) => ts && new Date(ts).getTime() > Date.now();

// ── Pre-auth site roster (the person-picker's data) ─────────────────────────
// Gated on possession of an ENROLLED ACTIVE kiosk device id; returns ONLY that
// site's active workers, minimal fields (what a gate list shows).
async function roster({ device_id, q }) {
  if (!isUuid(device_id)) throw genericAuthError();
  const cap = 500;   // big sites (5,000+) search server-side rather than page
  const query = q == null || String(q).trim() === '' ? null : String(q).trim().slice(0, 64);
  const r = await db.query('SELECT * FROM auth_kiosk_roster($1,$2,$3)', [device_id, cap, query]);
  if (r.rows.length === 0 && query == null) throw genericAuthError(); // not a kiosk / not active / empty site reads the same
  if (r.rows.length === 0) return { site: null, workers: [] };        // a search can honestly be empty
  return {
    site: r.rows[0].site_name,
    workers: r.rows.map((w) => ({ employee_id: w.employee_id, emp_no: w.emp_no, full_name: w.full_name })),
  };
}

// ── Kiosk sign-in: picked person + their PIN → SINGLE-USE clock-only token ──
async function kioskLogin({ device_id, employee_id, pin }) {
  if (!isUuid(device_id) || !isUuid(employee_id) || !pin) throw genericAuthError();
  const r = await db.query('SELECT * FROM auth_lookup_kiosk($1,$2)', [device_id, employee_id]);
  const d = r.rows[0];
  if (!d) throw genericAuthError();
  if (d.device_kind !== 'kiosk') throw genericAuthError();   // a personal phone is NOT a kiosk
  if (d.device_status !== 'active') throw genericAuthError();
  if (d.company_status !== 'active') throw genericAuthError();
  if (!d.employee_status) throw genericAuthError();          // person not in this tenant
  if (String(d.employee_site) !== String(d.site_id)) throw genericAuthError(); // not this site's worker
  if (!d.pin_hash) throw genericAuthError();                 // no field PIN enrolled
  if (future(d.locked_until)) throw genericAuthError();

  if (!C.verifySecret(pin, d.pin_hash)) {
    const threshold = await cfg.getInt(d.company_id, 'auth.lockout.threshold', 5);
    const duration  = await cfg.getInt(d.company_id, 'auth.lockout.duration', 900);
    await db.query('SELECT * FROM auth_fieldpin_fail($1,$2,$3)', [employee_id, threshold, duration]);
    throw genericAuthError();
  }

  // E14 discipline: identity proven — a suspended/terminated worker gets the
  // DISTINCT blocked answer (and no session), same as the personal path.
  if (d.employee_status === 'terminated') throw new HttpError(403, 'account terminated', { blocked: 'terminated' });
  if (d.employee_status === 'suspended')  throw new HttpError(403, 'account suspended',  { blocked: 'suspended' });

  const ttl = await cfg.getInt(d.company_id, 'kiosk.session.ttl', 120); // seconds — one punch
  const token = C.newToken();
  const s = await db.query('SELECT * FROM auth_kiosk_success($1,$2,$3,$4)',
    [device_id, employee_id, C.tokenHash(token), ttl]);
  return {
    token,
    kind: 'kiosk',
    expires_at: s.rows[0].expires_at,
    worker: { employee_id, full_name: d.full_name, emp_no: d.emp_no },
  };
}

// ── Photo at rest: decode the data URL, hand the BINARY to the ONE storage
// foundation (src/storage.js — Kira ruling 2026-07-14: punch photos, ESS
// documents and every future upload share it; path + sha256 in the DB, never
// base64; virus-scan recorded; retention per kind, PDPA-gated).
// NEVER throws into the punch: any failure returns null and the punch records
// FLAGGED (photo_missing=true) — a shift change of 200 people is never gated
// on a lens (records, not blocks).
async function storePunchPhoto(client, companyId, attId, dataUrl) {
  const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 64 || buf.length > 5 * 1024 * 1024) return null; // sane bounds
  const stored = await storage.put(client, companyId, 'punch-photo', buf, {
    owner_entity: 'attendance', owner_id: String(attId),
    content_type: m[1] === 'png' ? 'image/png' : 'image/jpeg', soft: true,
  });
  return stored ? stored.path : null;
}

// ── The kiosk punch: attribute to the PIN'd person, attach the photo evidence,
// record, then AUTO-LOGOUT (revoke the single-use session) — all one flow.
// The kiosk device is site-enrolled; the site binding is the location control
// (a fixed gate device carries no GPS fix), so the GPS geofence does not run —
// the punch records via='kiosk' with the capturing device id instead.
async function punch(session, { direction, photo }) {
  if (session.kind !== 'kiosk') throw new HttpError(403, 'kiosk punch requires a kiosk session');
  const dir = direction === 'out' ? 'out' : 'in';
  const co = session.company_id;
  const empId = session.employee_id;
  const out = await db.withTenant(co, async (c) => {
    if (dir === 'out') {
      const last = (await c.query(
        `SELECT direction FROM attendance WHERE employee_id=$1 ORDER BY punched_at DESC LIMIT 1`, [empId])).rows[0];
      if (!last || last.direction !== 'in') throw new HttpError(409, 'not clocked in');
    }
    const attId = crypto.randomUUID();
    const photoPath = await storePunchPhoto(c, co, attId, photo);
    await c.query(
      `INSERT INTO attendance(id, company_id, employee_id, direction, via, device_id, source,
                              photo_path, photo_missing)
       VALUES ($1,$2,$3,$4,'kiosk',$5,'kiosk',$6,$7)`,
      [attId, co, empId, dir, session.device_id, photoPath, photoPath == null]);
    await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
      co, String(empId), 'R13', `attendance.${dir}`, 'attendance', attId, null,
      { via: 'kiosk', device: session.device_id, photo: photoPath != null }]);
    return { ok: true, attendance_id: attId, direction: dir,
      photo_recorded: photoPath != null,
      ...(photoPath == null ? { flagged: 'no photo / review' } : {}) };
  });
  // AUTO-LOGOUT: the session dies WITH the punch — the next person starts clean.
  await db.query('SELECT auth_revoke_session($1)', [session.session_id]);
  return out;
}

module.exports = { roster, kioskLogin, punch, storePunchPhoto };
