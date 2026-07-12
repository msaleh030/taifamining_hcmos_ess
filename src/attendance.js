'use strict';
// F5 — attendance clock-in (self-service). The trust boundary: the server ALWAYS
// re-validates the location against the employee's site zones (geofence.js resolves
// the site from the authenticated session, not the request, and ignores any device
// "inside" verdict). Offline punches carry an idempotency key so a queued punch
// syncs once and a duplicate key never double-records.
//
// bughunt-B #12 + #16 hardening:
//   • the stored key is EMPLOYEE-SCOPED (`att:<employee>:<raw key>`) — two
//     employees whose devices generate the same raw key can never swallow each
//     other's punches;
//   • the dedup claim and the punch are ONE transaction, and the claim is a
//     single INSERT ... ON CONFLICT DO NOTHING (atomic): a racing duplicate
//     loses the claim, records nothing, and gets the winner's stored response —
//     never a duplicate punch, never a raw unique-violation 500. The punch id is
//     pre-generated so the full response is known at claim time (no follow-up
//     UPDATE — the app role's INSERT privilege on idempotency suffices).
const crypto = require('node:crypto');
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
  const rawKey = loc.idempotency_key || null;

  // Server-side re-validation. Throws 403 on reject; a coarse fix returns retry.
  const verdict = await geofence.validateClockIn(session, loc);
  if (verdict.retry) return verdict; // not a punch — nothing recorded, not deduped

  return db.withTenant(co, async (c) => {
    const empId = await employeeOf(c, session);
    if (!empId) throw new HttpError(403, 'no employee for user');
    // #12: scope the key to the employee BEFORE any lookup.
    const key = rawKey ? `att:${empId}:${rawKey}` : null;

    // Offline replay: a duplicate key returns the stored punch — no second record.
    if (key) {
      const seen = await c.query('SELECT response FROM idempotency WHERE company_id=$1 AND key=$2', [co, key]);
      if (seen.rows[0]) return { ...seen.rows[0].response, deduped: true };
    }

    // #16: pre-generate the punch id → the response is complete at claim time.
    const attId = crypto.randomUUID();
    const response = { ok: true, accepted: true, zone: verdict.zone || null,
      enforced: verdict.enforced !== false, attendance_id: attId };
    if (key) {
      const claim = await c.query(
        `INSERT INTO idempotency(company_id, key, response) VALUES ($1,$2,$3)
         ON CONFLICT (company_id, key) DO NOTHING RETURNING key`, [co, key, response]);
      if (claim.rows.length === 0) {
        // Lost the race: the winner's punch is the punch. Record nothing.
        const winner = await c.query('SELECT response FROM idempotency WHERE company_id=$1 AND key=$2', [co, key]);
        return { ...(winner.rows[0] ? winner.rows[0].response : response), deduped: true };
      }
    }
    await c.query(
      `INSERT INTO attendance(id, company_id, employee_id, lat, lng, accuracy, zone, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [attId, co, empId, Number(loc.lat), Number(loc.lng), loc.accuracy != null ? Number(loc.accuracy) : null,
       verdict.zone || null, loc.source || 'field']);
    return { ...response, deduped: false };
  });
}

module.exports = { clockIn };
