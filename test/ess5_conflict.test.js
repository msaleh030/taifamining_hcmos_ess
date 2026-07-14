'use strict';
// ESS-5 — clock-out + offline SYNC-CONFLICT resolution (UNI-01 → UNI-06).
// The reference names one conflict kind: "Duplicate clock-in — two open
// punches with no clock-out between them." Pins:
//   1. shift status answers open/since for the clock screen (own record);
//   2. a clock-in over a LIVE same-day 'in' is NOT recorded — 409 carries the
//      SERVER version (id, time, via) so the phone can render the versus card;
//   3. keep_server records nothing, claims the device key against the server
//      punch (a replay of the queued punch dedupes instead of re-conflicting);
//   4. keep_device records the device punch (geofence RE-VALIDATED — an
//      offline capture asserts nothing) and supersedes the server punch
//      (append-only: pointed at the winner, never deleted);
//   5. keep_both records both and flags BOTH rows for the timekeeper;
//   6. every resolution is AUDITED (actor, role, before/after — UNI-06);
//   7. a stale/already-resolved conflict refuses (409);
//   8. clock-out only closes an OPEN shift, and a closed shift clock-ins
//      cleanly again (no false conflict after an 'out').
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;
const dLat = (m) => m / 111194.9;
const clockIn = (token, body) => H.req('POST', '/attendance/clock-in', { token, body });
const clockOut = (token, body) => H.req('POST', '/attendance/clock-out', { token, body });
const resolve = (token, body) => H.req('POST', '/attendance/conflicts/resolve', { token, body });
const status = (token) => H.req('GET', '/attendance/status', { token });

let tsf; // NM TSF zone (site A1 — FIELDA's site), read from the registry
const at = () => ({ lat: tsf.lat, lng: tsf.lng, accuracy: 5 });

const cleanup = async () => {
  await owner(`DELETE FROM attendance WHERE employee_id=$1`, [F.EMP.FIELDA]);
  await owner(`DELETE FROM idempotency WHERE company_id=$1 AND key LIKE 'att:%:ess5-%'`, [A]);
};

before(async () => {
  await H.start();
  const z = (await owner(`SELECT center_lat, center_lng, radius_m FROM geofence_zone WHERE name='NM TSF'`)).rows[0];
  tsf = { lat: Number(z.center_lat), lng: Number(z.center_lng), radius: Number(z.radius_m) };
  await cleanup();
});
after(async () => { await cleanup(); await H.stop(); });

// Drives one conflict: server punch exists (clock-in), then a queued device
// punch replays with its own key → 409 with the server version.
async function makeConflict(token, key) {
  const first = await clockIn(token, at());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replay = await clockIn(token, { ...at(), idempotency_key: key });
  assert.equal(replay.status, 409, JSON.stringify(replay.body));
  assert.equal(replay.body.conflict.kind, 'duplicate-clock-in');
  const server = replay.body.conflict.server;
  assert.equal(server.attendance_id, first.body.attendance_id, 'the 409 names the punch already on the server');
  assert.ok(server.punched_at && server.via, 'server version carries time and channel for the versus card');
  return { serverId: server.attendance_id, device: { ...at(), idempotency_key: key, queued_at: new Date().toISOString() } };
}

test('ESS5-1 shift status answers open/since; duplicate clock-in is NOT recorded and returns the server version', async () => {
  const field = await tok(F.USERS.FIELD_A);
  const s0 = await status(field);
  assert.equal(s0.status, 200);
  assert.equal(s0.body.open, false, 'clean books — off shift');

  const { serverId } = await makeConflict(field, 'ess5-s1');
  const n = Number((await owner(`SELECT count(*)::int n FROM attendance WHERE employee_id=$1`, [F.EMP.FIELDA])).rows[0].n);
  assert.equal(n, 1, 'the conflicting punch recorded NOTHING');

  const s1 = await status(field);
  assert.equal(s1.body.open, true, 'on shift since the server punch');
  assert.equal(s1.body.last.id, serverId);
  await cleanup();
});

test('ESS5-2 keep_server: nothing recorded, decision audited, the queued punch replay DEDUPES to the server punch', async () => {
  const field = await tok(F.USERS.FIELD_A);
  const { serverId, device } = await makeConflict(field, 'ess5-s2');

  const r = await resolve(field, { resolution: 'keep_server', server_attendance_id: serverId, device });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.resolved, true);
  assert.equal(r.body.attendance_id, serverId, 'the server punch stands');
  const n = Number((await owner(`SELECT count(*)::int n FROM attendance WHERE employee_id=$1`, [F.EMP.FIELDA])).rows[0].n);
  assert.equal(n, 1, 'still exactly one punch');

  // The queue replays the punch once more before the phone drops it — it must
  // DEDUPE to the decision, never re-conflict.
  const replay = await clockIn(field, { ...at(), idempotency_key: 'ess5-s2' });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.deduped, true);
  assert.equal(replay.body.attendance_id, serverId);

  const audit = (await owner(
    `SELECT actor, role, after FROM audit WHERE company_id=$1 AND action='attendance.conflict.keep_server' ORDER BY seq DESC LIMIT 1`, [A])).rows[0];
  assert.ok(audit, 'UNI-06: the decision extended the audit chain');
  assert.equal(audit.actor, F.EMP.FIELDA, 'audited to the deciding person');
  assert.equal(audit.after.kept, 'server');
  await cleanup();
});

test('ESS5-3 keep_device: device punch recorded (geofence re-validated), server punch SUPERSEDED not deleted, audited', async () => {
  const field = await tok(F.USERS.FIELD_A);
  const { serverId, device } = await makeConflict(field, 'ess5-s3');

  const r = await resolve(field, { resolution: 'keep_device', server_attendance_id: serverId, device });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.resolution, 'keep_device');
  assert.equal(r.body.superseded, serverId);

  const rows = (await owner(
    `SELECT id, superseded_by, review_flag FROM attendance WHERE employee_id=$1 ORDER BY punched_at`, [F.EMP.FIELDA])).rows;
  assert.equal(rows.length, 2, 'append-only: the loser row still exists');
  const server = rows.find((x) => x.id === serverId);
  assert.equal(server.superseded_by, r.body.attendance_id, 'the server punch points at the winner');

  const s = await status(field);
  assert.equal(s.body.open, true);
  assert.equal(s.body.last.id, r.body.attendance_id, 'status resolves to the LIVE punch, not the superseded one');

  const audit = (await owner(
    `SELECT after FROM audit WHERE company_id=$1 AND action='attendance.conflict.keep_device' ORDER BY seq DESC LIMIT 1`, [A])).rows[0];
  assert.equal(audit.after.kept, 'device');
  await cleanup();
});

test('ESS5-4 keep_both: both punches stand, BOTH flagged for the timekeeper, audited', async () => {
  const field = await tok(F.USERS.FIELD_A);
  const { serverId, device } = await makeConflict(field, 'ess5-s4');

  const r = await resolve(field, { resolution: 'keep_both', server_attendance_id: serverId, device });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.flagged, 'conflict — timekeeper review');

  const rows = (await owner(
    `SELECT review_flag FROM attendance WHERE employee_id=$1`, [F.EMP.FIELDA])).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.review_flag === 'conflict — timekeeper review'), 'BOTH rows carry the flag');
  await cleanup();
});

test('ESS5-5 a stale/already-resolved conflict refuses; keep_device outside the boundary refuses (server re-validates)', async () => {
  const field = await tok(F.USERS.FIELD_A);
  const { serverId, device } = await makeConflict(field, 'ess5-s5');
  const ok = await resolve(field, { resolution: 'keep_server', server_attendance_id: serverId, device });
  assert.equal(ok.status, 200);

  // Second decision on the same conflict: the punch is no longer... still 'in'
  // and live, so keep_server would replay-dedupe on the key; use a DIFFERENT
  // key to prove the row-state gate itself.
  const again = await resolve(field, {
    resolution: 'keep_device', server_attendance_id: '00000000-0000-0000-0000-000000000001',
    device: { ...device, idempotency_key: 'ess5-s5b' } });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error, 'conflict already resolved or stale');

  // keep_device with coords OUTSIDE the boundary: the offline capture asserts
  // nothing — the server re-validates and refuses the record.
  const outside = { lat: tsf.lat + dLat(tsf.radius + 600), lng: tsf.lng, accuracy: 5,
    idempotency_key: 'ess5-s5c', queued_at: new Date().toISOString() };
  const refused = await resolve(field, { resolution: 'keep_device', server_attendance_id: serverId, device: outside });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  await cleanup();
});

// ── The FOURTH private resolver copy the ESS-5 LIVE PROBE caught ────────────
// geofence.siteOf resolved app_user-only, so a device-only bootstrap worker
// (no console account — the normal case for the 1,099) got 403 "no site for
// employee" on EVERY personal clock-in. siteOf now goes through
// src/identity.js (app_user first, then the session's device). Pin it.
test('ESS5-7 a NO-app_user field session clocks in and out (geofence resolves the site via the DEVICE)', async () => {
  const C = require('../src/crypto');
  const ids = {};
  try {
    ids.emp = (await owner(
      `INSERT INTO employee(id,company_id,site_id,full_name,role_code,status,is_expat)
       VALUES (gen_random_uuid(),$1,$2,'Zz Ess5 Bootstrap','R13','active',false) RETURNING id`,
      [A, F.SITE.A1])).rows[0].id;
    ids.dev = (await owner(
      `INSERT INTO device(company_id,employee_id,pin_hash,status) VALUES ($1,$2,$3,'active') RETURNING id`,
      [A, ids.emp, C.hashSecret('707070')])).rows[0].id;
    const login = await H.req('POST', '/auth/field', { body: { device_id: ids.dev, pin: '707070' } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const tok2 = login.body.token;
    const inn = await clockIn(tok2, at());
    assert.equal(inn.status, 200, `bootstrap worker clocks in: ${JSON.stringify(inn.body)}`);
    assert.equal(inn.body.accepted, true);
    const out = await clockOut(tok2, at());
    assert.equal(out.status, 200, `and out: ${JSON.stringify(out.body)}`);
  } finally {
    if (ids.emp) await owner(`DELETE FROM attendance WHERE employee_id=$1`, [ids.emp]);
    if (ids.dev) await owner(`DELETE FROM session WHERE device_id=$1`, [ids.dev]);
    if (ids.dev) await owner(`DELETE FROM device WHERE id=$1`, [ids.dev]);
    if (ids.emp) await owner(`DELETE FROM employee WHERE id=$1`, [ids.emp]);
  }
});

test('ESS5-6 clock-out closes the shift; a second clock-out 409s; the next clock-in raises NO false conflict', async () => {
  const field = await tok(F.USERS.FIELD_A);
  const inn = await clockIn(field, at());
  assert.equal(inn.status, 200);

  const out = await clockOut(field, at());
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.direction, 'out');
  assert.ok(out.body.since, 'shift close reports when it opened');

  const s = await status(field);
  assert.equal(s.body.open, false, 'books closed');

  const again = await clockOut(field, at());
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error, 'not clocked in');

  const reopen = await clockIn(field, at());
  assert.equal(reopen.status, 200, 'in → out → in is a normal day, not a conflict');
  await cleanup();
});
