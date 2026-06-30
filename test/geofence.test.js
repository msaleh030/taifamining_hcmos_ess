'use strict';
// SS-3 — Geofence clock-in. Multiple zones per site; valid if inside ANY zone of
// the employee's site; Haversine re-validated server-side; accuracy tolerance;
// HO empty-zone set must not lock staff out; spoofed coords are still recomputed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const geo = require('../src/geofence');
const { F } = H;

// Sessions resolve the employee's SITE server-side from user_id (not the request).
const A1 = { company_id: F.TENANT_A, user_id: F.USERS.PAYROLL_A.id }; // ALICE → SITE A1
const A2 = { company_id: F.TENANT_A, user_id: F.USERS.SITE2_A.id };   // DAVE  → SITE A2
const HO = { company_id: F.TENANT_A, user_id: F.USERS.HO_A.id };      // HOEMP → SITE HO (no zones)

// North Pit zone centre (radius 100 m) and a metre→degree helper at this latitude.
const PIT = { lat: -3.5000, lng: 32.0000 };
const dLat = (m) => m / 111194.9; // metres north → degrees latitude

before(H.start);
after(H.stop);

test('inside a zone accepts (server-recomputed)', async () => {
  const r = await geo.validateClockIn(A1, { lat: PIT.lat, lng: PIT.lng, accuracy: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.enforced, true);
  assert.equal(r.zone, 'North Pit');
});

test('inside ANY zone of the site accepts — second zone of the same site', async () => {
  // North Camp is a different zone mapped to the SAME site (A1).
  const r = await geo.validateClockIn(A1, { lat: -3.5500, lng: 32.0500, accuracy: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.zone, 'North Camp');
});

test('outside all zones rejects', async () => {
  const far = { lat: PIT.lat - dLat(500), lng: PIT.lng, accuracy: 10 }; // ~500 m out, far from North Camp too
  await assert.rejects(geo.validateClockIn(A1, far), /outside all geofence zones/);
});

test('a point valid for one site is rejected for another site’s employee', async () => {
  const atPit = { lat: PIT.lat, lng: PIT.lng, accuracy: 5 };
  await geo.validateClockIn(A1, atPit);                       // valid for an A1 employee
  await assert.rejects(geo.validateClockIn(A2, atPit),        // same point, A2 employee → rejected
    /outside all geofence zones/);
});

test('100 m zone, point beyond radius but within accuracy drift accepts; without drift rejects', async () => {
  const pt = { lat: PIT.lat - dLat(124), lng: PIT.lng }; // ~124 m from centre, radius is 100 m
  // accuracy 50 → tolerance 50 → 124 <= 100 + 50 → accepts
  const ok = await geo.validateClockIn(A1, { ...pt, accuracy: 50 });
  assert.equal(ok.ok, true);
  assert.equal(ok.tolerance_m, 50);
  // no drift → 124 > 100 → rejects (tolerance is what made the difference)
  await assert.rejects(geo.validateClockIn(A1, { ...pt, accuracy: 0 }), /outside all geofence zones/);
});

test('accuracy tolerance is capped (cannot be inflated past the cap)', async () => {
  const pt = { lat: PIT.lat - dLat(300), lng: PIT.lng }; // 300 m out; cap is 50 m
  // Even a claimed accuracy of 10 km cannot stretch a 100 m zone past 150 m.
  await assert.rejects(geo.validateClockIn(A1, { ...pt, accuracy: 10000 }), /outside all geofence zones/);
});

test('spoofed client verdict is ignored — server re-validates from coordinates', async () => {
  const far = { lat: PIT.lat - dLat(500), lng: PIT.lng, accuracy: 5,
    inside: true, client_validated: true, zone: 'North Pit' }; // all bogus
  await assert.rejects(geo.validateClockIn(A1, far), /outside all geofence zones/);
});

test('HO has no zones [OPEN] — clock-in is NOT auto-rejected (staff not locked out)', async () => {
  const r = await geo.validateClockIn(HO, { lat: 0, lng: 0, accuracy: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.enforced, false, 'geofence not enforced where a site has no zones');
});
