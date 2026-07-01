'use strict';
// F5 — attendance clock-in (self-service). The trust boundary: the server ALWAYS
// re-validates the location against the employee's site zones (geofence.js resolves
// the site from the authenticated session, not the request, and ignores any device
// "inside" verdict). Offline punches carry an idempotency key so a queued punch
// syncs once and a duplicate key never double-records.
const db = require('./db');
const geofence = require('./geofence');
const { HttpError } = require('./errors');

async function employeeOf(client, session) {
  if (!session.user_id) return null;
  const r = await client.query('SELECT employee_id FROM app_user WHERE id=$1', [session.user_id]);
  return r.rows[0] ? r.rows[0].employee_id : null;
}

async function clockIn(session, loc = {}) {
  const co = session.company_id;
  const key = loc.idempotency_key || null;

  // Offline replay: a duplicate key returns the stored punch — no second record.
  if (key) {
    const seen = await db.withTenant(co, (c) =>
      c.query('SELECT response FROM idempotency WHERE company_id=$1 AND key=$2', [co, key]));
    if (seen.rows[0]) return { ...seen.rows[0].response, deduped: true };
  }

  // Server-side re-validation. Throws 403 on reject; a coarse fix returns retry.
  const verdict = await geofence.validateClockIn(session, loc);
  if (verdict.retry) return verdict; // not a punch — nothing recorded, not deduped

  // Accepted → record the punch, and store the idempotency response to guard replays.
  return db.withTenant(co, async (c) => {
    const empId = await employeeOf(c, session);
    if (!empId) throw new HttpError(403, 'no employee for user');
    const att = (await c.query(
      `INSERT INTO attendance(company_id, employee_id, lat, lng, accuracy, zone, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [co, empId, Number(loc.lat), Number(loc.lng), loc.accuracy != null ? Number(loc.accuracy) : null,
       verdict.zone || null, loc.source || 'field'])).rows[0];
    const response = { ok: true, accepted: true, zone: verdict.zone || null, enforced: verdict.enforced !== false, attendance_id: att.id };
    if (key) await c.query('INSERT INTO idempotency(company_id, key, response) VALUES ($1,$2,$3)', [co, key, response]);
    return { ...response, deduped: false };
  });
}

module.exports = { clockIn };
