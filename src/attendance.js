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

const { employeeOf } = require('./identity'); // session→employee (device bootstrap included)

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

    // ESS-5 conflict detection (UNI-01 sync): "Duplicate clock-in — two open
    // punches with no clock-out between them." If this employee already has a
    // LIVE 'in' punch TODAY (not superseded by a resolution), a second clock-in
    // is not recorded — the caller gets the server version and must resolve
    // keep-device / keep-server / keep-both. Nothing is recorded, the offline
    // key stays unclaimed, the queued punch stays queued pending the decision.
    // A stale open punch from a PREVIOUS day never gates today's clock-in —
    // that is the timekeeper's reconciliation, not the worker's blocker.
    const open = (await c.query(
      `SELECT id, direction, punched_at::text AS at, via, zone,
              (punched_at::date = current_date) AS today
         FROM attendance WHERE employee_id=$1 AND superseded_by IS NULL
        ORDER BY punched_at DESC LIMIT 1`, [empId])).rows[0];
    if (open && open.direction === 'in' && open.today) {
      throw new HttpError(409, 'sync conflict — needs resolution', {
        conflict: {
          kind: 'duplicate-clock-in',
          server: { attendance_id: open.id, punched_at: open.at, via: open.via, zone: open.zone },
        },
      });
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
      `INSERT INTO attendance(id, company_id, employee_id, lat, lng, accuracy, zone, source, direction, via)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'in','personal')`,
      [attId, co, empId, Number(loc.lat), Number(loc.lng), loc.accuracy != null ? Number(loc.accuracy) : null,
       verdict.zone || null, loc.source || 'field']);
    return { ...response, deduped: false };
  });
}

// ── AC-ATT-02 (ESS-5): clock-out — shift close. Same trust boundary as
// clock-in (server-side geofence re-validation, employee-scoped idempotency),
// and it only closes an OPEN shift: the employee's latest punch must be an
// 'in' (the reference's empty state — "clock-out only captures against an
// open shift").
async function clockOut(session, loc = {}) {
  const co = session.company_id;
  const rawKey = loc.idempotency_key || null;

  const verdict = await geofence.validateClockIn(session, loc);
  if (verdict.retry) return verdict;

  return db.withTenant(co, async (c) => {
    const empId = await employeeOf(c, session);
    if (!empId) throw new HttpError(403, 'no employee for user');
    const last = (await c.query(
      `SELECT direction, punched_at::text AS at FROM attendance
        WHERE employee_id=$1 AND superseded_by IS NULL
        ORDER BY punched_at DESC LIMIT 1`, [empId])).rows[0];
    if (!last || last.direction !== 'in') throw new HttpError(409, 'not clocked in');

    const key = rawKey ? `att:${empId}:${rawKey}` : null;
    if (key) {
      const seen = await c.query('SELECT response FROM idempotency WHERE company_id=$1 AND key=$2', [co, key]);
      if (seen.rows[0]) return { ...seen.rows[0].response, deduped: true };
    }
    const attId = crypto.randomUUID();
    const response = { ok: true, accepted: true, direction: 'out', since: last.at,
      zone: verdict.zone || null, attendance_id: attId };
    if (key) {
      const claim = await c.query(
        `INSERT INTO idempotency(company_id, key, response) VALUES ($1,$2,$3)
         ON CONFLICT (company_id, key) DO NOTHING RETURNING key`, [co, key, response]);
      if (claim.rows.length === 0) {
        const winner = await c.query('SELECT response FROM idempotency WHERE company_id=$1 AND key=$2', [co, key]);
        return { ...(winner.rows[0] ? winner.rows[0].response : response), deduped: true };
      }
    }
    await c.query(
      `INSERT INTO attendance(id, company_id, employee_id, lat, lng, accuracy, zone, source, direction, via)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'out','personal')`,
      [attId, co, empId, Number(loc.lat), Number(loc.lng), loc.accuracy != null ? Number(loc.accuracy) : null,
       verdict.zone || null, loc.source || 'field']);
    return { ...response, deduped: false };
  });
}

// ── ESS-5: shift status for the clock screen — is there an open punch, since
// when. Read-only, own record (session→employee), no arguments from the client.
async function status(session) {
  return db.withTenant(session.company_id, async (c) => {
    const empId = await employeeOf(c, session);
    if (!empId) throw new HttpError(403, 'no employee for user');
    const last = (await c.query(
      `SELECT id, direction, punched_at::text AS at, via, zone, review_flag
         FROM attendance WHERE employee_id=$1 AND superseded_by IS NULL
        ORDER BY punched_at DESC LIMIT 1`, [empId])).rows[0] || null;
    return {
      open: !!(last && last.direction === 'in'),
      since: last && last.direction === 'in' ? last.at : null,
      last,
    };
  });
}

// ── ESS-5: sync-conflict resolution (UNI-06). The worker decided on the phone:
// keep-device / keep-server / keep-both. The decision is AUDITED (actor, role,
// before/after) and the server stays the source of truth:
//   keep_server — nothing new is recorded; the device punch's idempotency key
//     is claimed against the SERVER punch so a replay of the queued punch
//     dedupes instead of re-conflicting;
//   keep_device — the device punch is recorded (geofence RE-VALIDATED
//     server-side — an offline capture asserts nothing) and the server punch
//     is superseded (never deleted — append-only, it points at the winner);
//   keep_both — both punches stand, BOTH rows are flagged
//     'conflict — timekeeper review' (the reference's "Keep both · flag for
//     timekeeper").
const RESOLUTIONS = new Set(['keep_server', 'keep_device', 'keep_both']);
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

// The device-captured time is recorded when it is SANE (parseable, not in the
// future beyond clock skew, not older than a week); otherwise the record
// falls back to now() and the audit entry still carries the device's claim.
function deviceTime(queuedAt) {
  const t = new Date(String(queuedAt || '')).getTime();
  if (!Number.isFinite(t)) return null;
  const now = Date.now();
  if (t > now + 5 * 60 * 1000 || t < now - 7 * 24 * 3600 * 1000) return null;
  return new Date(t).toISOString();
}

async function resolveConflict(session, body = {}) {
  const co = session.company_id;
  const resolution = String(body.resolution || '');
  const serverId = body.server_attendance_id;
  const device = body.device || {};
  if (!RESOLUTIONS.has(resolution)) throw new HttpError(400, 'unknown resolution');
  if (!isUuid(serverId)) throw new HttpError(400, 'server_attendance_id required');

  // Keeping the device punch RECORDS it — same trust boundary as any punch:
  // the server re-validates the geofence fix; a coarse fix is a HOLD (the
  // conflict stays unresolved, retry with a clearer reading), outside is 403.
  let verdict = null;
  if (resolution !== 'keep_server') {
    verdict = await geofence.validateClockIn(session, device);
    if (verdict.retry) return { ...verdict, resolved: false };
  }

  return db.withTenant(co, async (c) => {
    const empId = await employeeOf(c, session);
    if (!empId) throw new HttpError(403, 'no employee for user');
    const rawKey = device.idempotency_key || null;
    const key = rawKey ? `att:${empId}:${rawKey}` : null;

    // A replayed resolution returns the stored decision — never re-executes.
    if (key) {
      const seen = await c.query('SELECT response FROM idempotency WHERE company_id=$1 AND key=$2', [co, key]);
      if (seen.rows[0]) return { ...seen.rows[0].response, deduped: true };
    }

    // The server punch must still be THIS employee's live open clock-in.
    const server = (await c.query(
      `SELECT id, direction, punched_at::text AS at, via, zone, review_flag
         FROM attendance
        WHERE id=$1 AND employee_id=$2 AND superseded_by IS NULL
        FOR UPDATE`, [serverId, empId])).rows[0];
    if (!server || server.direction !== 'in') {
      throw new HttpError(409, 'conflict already resolved or stale');
    }

    const audit = (before, after) => c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
      co, String(empId), session.role_code || 'R13', `attendance.conflict.${resolution}`,
      'attendance', server.id, before, after]);

    if (resolution === 'keep_server') {
      const response = { ok: true, resolved: true, resolution, attendance_id: server.id };
      if (key) {
        await c.query(
          `INSERT INTO idempotency(company_id, key, response) VALUES ($1,$2,$3)
           ON CONFLICT (company_id, key) DO NOTHING`, [co, key, response]);
      }
      await audit({ server }, { kept: 'server', discarded_device: { ...device, lat: undefined, lng: undefined } });
      return { ...response, deduped: false };
    }

    const attId = crypto.randomUUID();
    const at = deviceTime(device.queued_at);
    const flagged = resolution === 'keep_both' ? 'conflict — timekeeper review' : null;
    await c.query(
      `INSERT INTO attendance(id, company_id, employee_id, lat, lng, accuracy, zone, source,
                              direction, via, punched_at, review_flag)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'field-sync','in','personal', coalesce($8::timestamptz, now()), $9)`,
      [attId, co, empId, Number(device.lat), Number(device.lng),
       device.accuracy != null ? Number(device.accuracy) : null,
       verdict.zone || null, at, flagged]);

    let response;
    if (resolution === 'keep_device') {
      await c.query(`UPDATE attendance SET superseded_by=$1 WHERE id=$2`, [attId, server.id]);
      response = { ok: true, resolved: true, resolution, attendance_id: attId,
        superseded: server.id, zone: verdict.zone || null };
      await audit({ server }, { kept: 'device', attendance_id: attId, device_time: at });
    } else {
      await c.query(`UPDATE attendance SET review_flag=$1 WHERE id=$2`, [flagged, server.id]);
      response = { ok: true, resolved: true, resolution, attendance_id: attId,
        kept_server: server.id, flagged, zone: verdict.zone || null };
      await audit({ server }, { kept: 'both', attendance_id: attId, flagged, device_time: at });
    }
    if (key) {
      await c.query(
        `INSERT INTO idempotency(company_id, key, response) VALUES ($1,$2,$3)
         ON CONFLICT (company_id, key) DO NOTHING`, [co, key, response]);
    }
    return { ...response, deduped: false };
  });
}

module.exports = { clockIn, clockOut, status, resolveConflict };
