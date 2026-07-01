'use strict';
// Geofence clock-in validation (SS-3).
//
// A clock-in is valid if the location — RE-VALIDATED SERVER-SIDE here, never
// trusting any client "I'm inside" verdict — is inside ANY zone mapped to the
// employee's site. The employee's site is resolved from their authenticated
// identity (server-trusted), not from the request body, so a caller cannot claim
// a different site. Zones come from the registry (geofence_zone); nothing here
// hard-codes a centre or radius.
//
// Accuracy tolerance (CONFIRMED v1.4): a fix is accepted when
//   distance <= radius + min(device_accuracy, geofence.tolerance.max_m=50)
// The cap bounds how far a (possibly inflated) accuracy figure can stretch a zone.
// The 50 m cap and 100 m retry threshold are pinned by test/f5.test.js (ATT-03),
// not by these comments — a changed threshold fails that test.
//
// Three outcomes, not two: a fix reported with accuracy worse than
// geofence.accuracy.retry_above_m (100 m) is NEITHER accepted nor rejected — the
// caller is asked to retry in open sky. HO now has a zone, so an empty zone set is
// only a defensive path (geofence.empty_zone.policy) for any unmapped site.
const db = require('./db');
const cfg = require('./config');
const { HttpError } = require('./errors');

const EARTH_M = 6371000; // mean earth radius, metres
const rad = (d) => (d * Math.PI) / 180;

// Great-circle distance between two lat/lng points, in metres.
function haversine(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

// The employee's site, resolved from their app_user → employee (RLS-scoped).
async function siteOf(client, session) {
  if (!session.user_id) return null;
  const r = await client.query(
    'SELECT e.site_id FROM app_user u JOIN employee e ON e.id = u.employee_id WHERE u.id=$1',
    [session.user_id]);
  return r.rows[0] ? r.rows[0].site_id : null;
}

// Validate a clock-in. `loc` carries ONLY device-reported geometry
// (lat, lng, accuracy); any other field (e.g. a client "inside" flag) is ignored
// — the verdict is always recomputed from coordinates here.
async function validateClockIn(session, loc = {}) {
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  const accuracy = isNum(Number(loc.accuracy)) && Number(loc.accuracy) > 0 ? Number(loc.accuracy) : 0;
  if (!isNum(lat) || !isNum(lng)) throw new HttpError(400, 'location required');

  return db.withTenant(session.company_id, async (client) => {
    const siteId = await siteOf(client, session);
    if (!siteId) throw new HttpError(403, 'no site for employee');

    const zones = (await client.query(
      'SELECT name, center_lat, center_lng, radius_m FROM geofence_zone WHERE site_id=$1', [siteId])).rows;

    if (zones.length === 0) {
      // Defensive: an unmapped site does not hard-reject (HO now has a zone).
      const policy = await cfg.getConfig(session.company_id, 'geofence.empty_zone.policy', 'allow', client);
      if (policy === 'reject') throw new HttpError(403, 'outside geofence (no zones, policy=reject)');
      return { ok: true, enforced: false, site_id: siteId, reason: `no_zones_policy_${policy}` };
    }

    // Too-coarse fix: neither accept nor reject — ask for a better one. Checked
    // only where geofence is enforced (the site has zones).
    const retryAbove = await cfg.getInt(session.company_id, 'geofence.accuracy.retry_above_m', 100, client);
    if (accuracy > retryAbove) {
      return {
        ok: false, retry: true, site_id: siteId,
        reason: 'no reliable GPS, retry in open sky',
        accuracy_m: Math.round(accuracy), threshold_m: retryAbove,
      };
    }

    const tolPolicy = await cfg.getConfig(session.company_id, 'geofence.tolerance.policy', 'accuracy', client);
    const tolMax = await cfg.getInt(session.company_id, 'geofence.tolerance.max_m', 50, client);
    const tolerance = tolPolicy === 'none' ? 0 : Math.min(accuracy, tolMax);

    let nearest = null;
    for (const z of zones) {
      const distance = haversine(lat, lng, Number(z.center_lat), Number(z.center_lng));
      if (!nearest || distance < nearest.distance_m) {
        nearest = { zone: z.name, distance_m: Math.round(distance), radius_m: Number(z.radius_m) };
      }
      if (distance <= Number(z.radius_m) + tolerance) {
        return {
          ok: true, enforced: true, site_id: siteId, zone: z.name,
          distance_m: Math.round(distance), radius_m: Number(z.radius_m), tolerance_m: Math.round(tolerance),
        };
      }
    }
    throw new HttpError(403, 'outside all geofence zones', { nearest });
  });
}

module.exports = { validateClockIn, haversine };
