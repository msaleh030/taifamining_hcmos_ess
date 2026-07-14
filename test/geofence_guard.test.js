'use strict';
// Wave 4 (Kira 2026-07-13): a geofence sign error must FAIL LOUDLY at INSERT,
// never silently at clock-in; and auth.signin now records source_ip +
// mfa_presented (forward-only, hash payload unchanged).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
before(H.start);
after(H.stop);

test('4.3 geofence guard: a POSITIVE Tanzanian latitude (dropped minus) is REJECTED at insert', async () => {
  // Dar Yard's error: +6.856552 would place the zone in Ethiopia and lock out 67 staff.
  await assert.rejects(
    owner(`INSERT INTO geofence_zone (company_id, site_id, name, center_lat, center_lng, radius_m)
           VALUES ($1,$2,'Zz Sign Error', 6.856552, 39.224217, 200)`, [F.TENANT_A, F.SITE.A1]),
    /geofence_zone_tz_bounds/, 'a positive latitude must violate the TZ-bounds guard');
  // The CORRECTED negative value inserts fine.
  const ok = await owner(
    `INSERT INTO geofence_zone (company_id, site_id, name, center_lat, center_lng, radius_m)
     VALUES ($1,$2,'Zz Dar Correct', -6.856552, 39.224217, 200) RETURNING id`, [F.TENANT_A, F.SITE.A1]);
  assert.ok(ok.rows[0].id);
  await owner(`DELETE FROM geofence_zone WHERE name='Zz Dar Correct'`);
  // Longitude guard too: outside 29.3..40.5 is rejected.
  await assert.rejects(
    owner(`INSERT INTO geofence_zone (company_id, site_id, name, center_lat, center_lng, radius_m)
           VALUES ($1,$2,'Zz Lng Error', -6.75, 12.0, 200)`, [F.TENANT_A, F.SITE.A1]),
    /geofence_zone_tz_bounds/);
});

test('audit forensics: a console sign-in records source_ip + mfa_presented, chain intact', async () => {
  const before = (await owner(`SELECT coalesce(max(seq),0)::int n FROM audit`)).rows[0].n;
  const login = await H.loginConsole(F.USERS.PAYROLL_A); // R07, MFA presented
  assert.equal(login.status, 200);
  const row = (await owner(
    `SELECT action, mfa_presented, source_ip FROM audit
      WHERE action='auth.signin' AND seq > $1 ORDER BY seq DESC LIMIT 1`, [before])).rows[0];
  assert.ok(row, 'an auth.signin row was written');
  assert.equal(row.mfa_presented, true, 'MFA was presented on this login and recorded');
  // source_ip is null in-process (no proxy header in the test client) — the COLUMN exists
  // and is populated by the server from CF-Connecting-IP in production. Presence, not value.
  assert.ok('source_ip' in row, 'source_ip column is present on the audit row');

  // The hash chain still verifies — the new columns are NOT in the payload.
  const chainOk = (await owner(`
    SELECT bool_and(hash = encode(sha256(convert_to(prev_hash || concat_ws('|',
      company_id::text, coalesce(actor,''), coalesce(role,''), action,
      coalesce(entity,''), coalesce(entity_id,''), ts::text,
      coalesce(before::text,''), coalesce(after::text,'')), 'UTF8')),'hex')) AS ok FROM audit`)).rows[0].ok;
  assert.equal(chainOk, true, 'audit chain recompute still holds after the forward-only column add');
});
