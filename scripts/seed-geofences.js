'use strict';
// Seed the six confirmed geofence zones (Kira Wave 4, 2026-07-13). Coordinates
// are CONFIRMED FINAL, including Dar Yard's NEGATIVE latitude (the +6.856552
// originally supplied was a dropped minus sign that would have placed the zone
// 1,513 km away in Ethiopia and silently locked out all 67 staff).
//
// Each zone is parse-checked against the Tanzania bounds BEFORE insert — the
// same guard migration 034 enforces at the DB, so a sign error fails loudly at
// insert, never silently at clock-in. Idempotent: upsert by (site, name).
//
//   UAT_COMPANY=<uuid> node scripts/seed-geofences.js
const db = require('../src/db');

// lat, lng, radius_m — FINAL (Kira 2026-07-13).
const ZONES = [
  ['Head Office',                          -6.754188, 39.273797, 200],
  ['Mwadui',                               -3.524574, 33.591796, 300],
  ['North Mara - L&H and Airstrip Project', -1.421284, 34.553155, 300],
  ['North Mara - TSF Lift 10 Project',     -1.478784, 34.504310, 400],
  ['Nyanzaga - Sotta Mining Project',      -2.938408, 32.679158, 800],
  ['Dar Yard',                             -6.856552, 39.224217, 200],
];
const inTZ = (lat, lng) => lat >= -11.75 && lat <= -0.95 && lng >= 29.3 && lng <= 40.5;

async function main() {
  const company = process.env.UAT_COMPANY;
  if (!company) throw new Error('set UAT_COMPANY');

  // 4.1/4.2 — CONFIRM THE PARSE-BACK before any insert.
  console.log('geofence seed — parse-back check (must all be inside Tanzania):');
  let bad = 0;
  for (const [site, lat, lng, r] of ZONES) {
    const ok = inTZ(lat, lng);
    if (!ok) bad += 1;
    console.log(`  ${ok ? 'OK ' : 'REJECT'}  ${site.padEnd(40)} lat=${lat} lng=${lng} r=${r}m`);
  }
  if (bad) throw new Error(`${bad} zone(s) failed the Tanzania-bounds parse-back — refusing to seed`);

  await db.withOwner(async (c) => {
    let seeded = 0;
    for (const [siteName, lat, lng, r] of ZONES) {
      const site = (await c.query(
        'SELECT id FROM site WHERE company_id=$1 AND name=$2', [company, siteName])).rows[0];
      if (!site) { console.log(`  SKIP ${siteName} — site not on this box`); continue; }
      // Idempotent upsert by (site, name); the DB guard (migration 034) is the
      // real backstop — this insert will fail loudly on any out-of-bounds value.
      const upd = await c.query(
        `UPDATE geofence_zone SET center_lat=$3, center_lng=$4, radius_m=$5
          WHERE company_id=$1 AND site_id=$2 AND name=$6`,
        [company, site.id, lat, lng, r, siteName]);
      if (!upd.rowCount) await c.query(
        `INSERT INTO geofence_zone (company_id, site_id, name, center_lat, center_lng, radius_m)
         VALUES ($1,$2,$3,$4,$5,$6)`, [company, site.id, siteName, lat, lng, r]);
      seeded += 1;
    }
    // Read the rows BACK from the DB and print them — proof the values round-trip.
    const back = (await c.query(
      `SELECT s.name AS site, z.name AS zone, z.center_lat, z.center_lng, z.radius_m
         FROM geofence_zone z JOIN site s ON s.id = z.site_id
        WHERE z.company_id=$1 ORDER BY s.name`, [company])).rows;
    console.log(`\ngeofence zones now in the DB (${seeded} seeded/updated):`);
    for (const z of back) console.log(`  ${z.site.padEnd(40)} lat=${z.center_lat} lng=${z.center_lng} r=${z.radius_m}m`);
  });
  await db.close();
}
main().catch((e) => { console.error('[seed-geofences] FAILED:', e.message); process.exit(1); });
