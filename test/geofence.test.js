'use strict';
// SS-3 (registry v1.2, O-1 closed) — Geofence clock-in. Zones-per-site from the
// registry; valid if inside ANY zone of the employee's site; Haversine
// re-validated server-side; accept when distance <= radius + min(accuracy, 50);
// accuracy > 100 prompts retry (neither accept nor reject); coords for one site
// don't validate at another. Tests read zone centres from the registry so they
// never hard-code coordinates. Deterministic single-zone assertions use the MW
// zones (Workshop r300 / Production r100, centres ~379 m apart) because the NM
// Gokona pair overlap (~67 m) per the real survey.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const geo = require('../src/geofence');
const { F } = H;

// Sessions resolve the employee's SITE server-side from user_id (not the request).
const MW = { company_id: F.TENANT_A, user_id: F.USERS.SITE2_A.id };   // DAVE  → SITE A2 (Mwadui)
const NM = { company_id: F.TENANT_A, user_id: F.USERS.PAYROLL_A.id }; // ALICE → SITE A1 (North Mara)
const BB = { company_id: F.TENANT_B, user_id: F.USERS.BOB_B.id };     // BOB   → SITE B1 (no zones)

const M_PER_DEG_LAT = 111194.9;
const dLat = (m) => m / M_PER_DEG_LAT; // metres north → degrees latitude

// Read a zone centre/radius from the registry (never hard-code the coordinates).
async function zone(name) {
  const r = await db.withOwner((c) => c.query(
    'SELECT center_lat, center_lng, radius_m FROM geofence_zone WHERE name=$1', [name]));
  const z = r.rows[0];
  return { lat: Number(z.center_lat), lng: Number(z.center_lng), radius: Number(z.radius_m) };
}

before(H.start);
after(H.stop);

test('inside a zone accepts (server-recomputed)', async () => {
  const z = await zone('MW Workshop');
  const r = await geo.validateClockIn(MW, { lat: z.lat, lng: z.lng, accuracy: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.enforced, true);
  assert.equal(r.zone, 'MW Workshop');
});

test('inside ANY zone of the site accepts — a different zone of the same site', async () => {
  const z = await zone('MW Production'); // same site (Mwadui) as MW Workshop
  const r = await geo.validateClockIn(MW, { lat: z.lat, lng: z.lng, accuracy: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.zone, 'MW Production');
});

test('outside all zones rejects', async () => {
  const z = await zone('MW Workshop');
  const far = { lat: z.lat + dLat(1000), lng: z.lng, accuracy: 10 }; // ~1 km out, clear of MW Production too
  await assert.rejects(geo.validateClockIn(MW, far), /outside all geofence zones/);
});

test('a point valid for site A is rejected for site B’s employee', async () => {
  const z = await zone('MW Workshop');             // a Mwadui zone
  const atMW = { lat: z.lat, lng: z.lng, accuracy: 5 };
  const ok = await geo.validateClockIn(MW, atMW);
  assert.equal(ok.ok, true);                       // valid for a Mwadui employee
  await assert.rejects(geo.validateClockIn(NM, atMW), // same point, North Mara employee → rejected
    /outside all geofence zones/);
});

test('100 m zone, point ~130 m out with 40 m accuracy accepts (tolerance); no drift rejects', async () => {
  const z = await zone('MW Production'); // radius 100 m
  assert.equal(z.radius, 100);
  const pt = { lat: z.lat + dLat(130), lng: z.lng }; // ~130 m north (away from MW Workshop)
  // 130 <= 100 + min(40,50)=140 → accepts
  const ok = await geo.validateClockIn(MW, { ...pt, accuracy: 40 });
  assert.equal(ok.ok, true);
  assert.equal(ok.zone, 'MW Production');
  assert.equal(ok.tolerance_m, 40);
  // no drift → 130 > 100 → rejects (tolerance is the deciding factor)
  await assert.rejects(geo.validateClockIn(MW, { ...pt, accuracy: 0 }), /outside all geofence zones/);
});

test('accuracy > 100 m prompts retry — neither accept nor reject', async () => {
  const z = await zone('MW Workshop');
  // Even standing at the exact centre, a > 100 m fix is too coarse to trust.
  const r = await geo.validateClockIn(MW, { lat: z.lat, lng: z.lng, accuracy: 150 });
  assert.equal(r.ok, false);
  assert.equal(r.retry, true);
  assert.match(r.reason, /no reliable GPS, retry in open sky/);
  assert.equal(r.threshold_m, 100);
});

test('tolerance is capped at 50 m (cannot be inflated past the cap)', async () => {
  const z = await zone('MW Production'); // 100 m
  const pt = { lat: z.lat + dLat(160), lng: z.lng }; // 160 m out; even capped tol (50) → 150 < 160
  // accuracy 90 is under the 100 retry threshold but capped at 50 for tolerance.
  await assert.rejects(geo.validateClockIn(MW, { ...pt, accuracy: 90 }), /outside all geofence zones/);
});

test('spoofed client verdict is ignored — server re-validates from coordinates', async () => {
  const z = await zone('MW Workshop');
  const far = { lat: z.lat + dLat(1000), lng: z.lng, accuracy: 5,
    inside: true, client_validated: true, zone: 'MW Workshop' }; // all bogus
  await assert.rejects(geo.validateClockIn(MW, far), /outside all geofence zones/);
});

test('a site with no zones does not hard-reject (defensive empty-zone policy)', async () => {
  const r = await geo.validateClockIn(BB, { lat: 0, lng: 0, accuracy: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.enforced, false);
});
