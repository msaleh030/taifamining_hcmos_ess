'use strict';
// F5 — attendance/geofence clock-in as INTEGRATION tests through the real HTTP
// endpoint. ATT-01/02/03 + UNI-01 (offline). The must-prove: SPOOFED coords with a
// device "inside" verdict are recomputed server-side and REJECTED — the client
// cannot assert its way in. Zone coordinates/radii come from the registry (v1.4).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;
const dLat = (m) => m / 111194.9;
const clock = (token, body) => H.req('POST', '/attendance/clock-in', { token, body });
// ESS-5: a second clock-in over a live same-day 'in' now 409s as a sync
// conflict (duplicate clock-in). These tests pin the GEOFENCE semantics, so
// each clears the books first — the conflict flow has its own test file.
// (Postgres array literal by hand — the vendored client JSON-serialises JS arrays.)
const clearOpen = (...empIds) => owner(
  `DELETE FROM attendance WHERE employee_id = ANY($1::uuid[]) AND direction='in' AND punched_at::date = current_date`,
  [`{${empIds.join(',')}}`]);
async function zone(name) {
  const z = (await owner(`SELECT center_lat, center_lng, radius_m FROM geofence_zone WHERE name=$1`, [name])).rows[0];
  return { lat: Number(z.center_lat), lng: Number(z.center_lng), radius: Number(z.radius_m) };
}

before(H.start);
after(H.stop);

// ── ATT-01/02: inside accepts, outside rejects, spoof rejected, site-scoped ──
test('ATT-01/02 inside accepts; outside rejects; a spoofed verdict is rejected server-side; site-scoped', async () => {
  const tsf = await zone('NM TSF');
  assert.equal(tsf.radius, 400, 'confirmed v1.4 zone is loaded from the registry');
  const field = await tok(F.USERS.FIELD_A); // FIELDA → SITE A1 (North Mara)
  await clearOpen(F.EMP.FIELDA); // stale open punches from a prior run are conflicts now

  const inside = await clock(field, { lat: tsf.lat, lng: tsf.lng, accuracy: 5 });
  assert.equal(inside.status, 200);
  assert.equal(inside.body.accepted, true);
  assert.equal(inside.body.zone, 'NM TSF');

  const far = { lat: tsf.lat + dLat(tsf.radius + 600), lng: tsf.lng, accuracy: 10 };
  assert.equal((await clock(field, far)).status, 403, 'outside all zones rejects');

  // SPOOF: device claims it is inside, but the real coords are outside → server
  // recomputes and rejects. The client verdict is ignored.
  const spoof = { ...far, accuracy: 5, inside: true, client_validated: true, zone: 'NM TSF' };
  assert.equal((await clock(field, spoof)).status, 403, 'spoofed "inside" is rejected server-side');

  // Site-scoped: the NM point is valid for the A1 employee, rejected for an A2 one.
  const dave = await tok(F.USERS.SITE2_A); // DAVE → SITE A2 (Mwadui)
  await clearOpen(F.EMP.FIELDA); // close the books — geofence is the pin here, not the conflict flow
  assert.equal((await clock(field, { lat: tsf.lat, lng: tsf.lng, accuracy: 5 })).body.accepted, true);
  assert.equal((await clock(dave, { lat: tsf.lat, lng: tsf.lng, accuracy: 5 })).status, 403, 'A point valid for site A is rejected for a site-B employee');
});

// ── ATT-03: accuracy tolerance near a boundary; coarse GPS retries ──────────
test('ATT-03 tolerance accepts near a boundary; accuracy > 100 m returns retry', async () => {
  const prod = await zone('MW Production'); // r100
  const dave = await tok(F.USERS.SITE2_A);
  await clearOpen(F.EMP.DAVE);
  const pt = { lat: prod.lat + dLat(130), lng: prod.lng }; // ~130 m out (away from MW Workshop)

  const ok = await clock(dave, { ...pt, accuracy: 40 }); // 130 <= 100 + min(40,50)
  assert.equal(ok.status, 200);
  assert.equal(ok.body.accepted, true);

  assert.equal((await clock(dave, { ...pt, accuracy: 0 })).status, 403, 'no tolerance → outside → reject');

  const retry = await clock(dave, { lat: prod.lat, lng: prod.lng, accuracy: 150 });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.retry, true, 'coarse GPS → retry (not accept, not hard reject)');
});

// ── UNI-01: offline capture — a duplicate idempotency key records once ───────
test('UNI-01 an offline punch with an idempotency key syncs once; a duplicate does not double-record', async () => {
  const tsf = await zone('NM TSF');
  const field = await tok(F.USERS.FIELD_A);
  const key = 'f5-offline-1';
  await clearOpen(F.EMP.FIELDA);
  const before = Number((await owner(`SELECT count(*)::int n FROM attendance WHERE employee_id=$1`, [F.EMP.FIELDA])).rows[0].n);

  const first = await clock(field, { lat: tsf.lat, lng: tsf.lng, accuracy: 5, idempotency_key: key });
  assert.equal(first.body.accepted, true);
  assert.equal(first.body.deduped, false);

  const dup = await clock(field, { lat: tsf.lat, lng: tsf.lng, accuracy: 5, idempotency_key: key });
  assert.equal(dup.body.deduped, true, 'duplicate key returns the stored punch');

  const after = Number((await owner(`SELECT count(*)::int n FROM attendance WHERE employee_id=$1`, [F.EMP.FIELDA])).rows[0].n);
  assert.equal(after, before + 1, 'recorded exactly once');

  // Stored keys are employee-scoped (att:<employee>:<raw>) — clean by pattern.
  await owner(`DELETE FROM idempotency WHERE key LIKE 'att:%:' || $1`, [key]);
});

// ── bughunt-B #12: the stored key is EMPLOYEE-scoped — two employees whose
// devices generate the SAME raw key must each record their own punch; the
// second must never be handed the first's stored response. #16 rides along:
// the claim + punch are one atomic transaction (same-employee replay still
// dedupes; a lost race records nothing). ─────────────────────────────────────
test('UNI-02 two employees using the same raw idempotency key each record their own punch', async () => {
  const tsf = await zone('NM TSF');
  const key = 'f5-shared-raw-key';
  const field = await tok(F.USERS.FIELD_A); // → EMP.FIELDA (site A1)
  const emp = await tok(F.USERS.EMP_A);     // → EMP.ALICE  (site A1)
  await clearOpen(F.EMP.FIELDA, F.EMP.ALICE);
  const countOf = async (id) => Number((await owner(
    `SELECT count(*)::int n FROM attendance WHERE employee_id=$1`, [id])).rows[0].n);
  const b1 = await countOf(F.EMP.FIELDA), b2 = await countOf(F.EMP.ALICE);

  const r1 = await clock(field, { lat: tsf.lat, lng: tsf.lng, accuracy: 5, idempotency_key: key });
  const r2 = await clock(emp, { lat: tsf.lat, lng: tsf.lng, accuracy: 5, idempotency_key: key });
  assert.equal(r1.body.deduped, false);
  assert.equal(r2.body.deduped, false, 'employee 2 is NOT swallowed by employee 1\'s key');
  assert.notEqual(r1.body.attendance_id, r2.body.attendance_id, 'two distinct punches');
  assert.equal(await countOf(F.EMP.FIELDA), b1 + 1, 'employee 1 recorded their own punch');
  assert.equal(await countOf(F.EMP.ALICE), b2 + 1, 'employee 2 recorded their own punch');

  // Same-employee replay still dedupes (the scoping never broke idempotency).
  const replay = await clock(emp, { lat: tsf.lat, lng: tsf.lng, accuracy: 5, idempotency_key: key });
  assert.equal(replay.body.deduped, true, 'the same employee replaying the key gets the stored punch');
  assert.equal(await countOf(F.EMP.ALICE), b2 + 1, 'no second record on replay');

  await owner(`DELETE FROM idempotency WHERE key LIKE 'att:%:' || $1`, [key]);
});
