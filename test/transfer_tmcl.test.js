'use strict';
// TRANSFER ruling (Kira 2026-07-14): a transferred employee KEEPS their
// site-prefixed TMCL number — the number is permanent identity; site is a
// mutable attribute. The prefix may DISAGREE with the live site, and NOTHING
// may infer site from it: geofence, site-scope, reports all read the live
// site_id. This pins the consequence with a deliberately mismatched person:
// a TMCL-MW-numbered worker whose LIVE site is A1 (North Mara) clocks in at
// the A1 zones — the MW prefix plays no part.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const C = require('../src/crypto');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const ids = {};

before(async () => {
  await H.start();
  // A "transferred" person: MW-prefixed number, LIVE site A1 (North Mara).
  ids.emp = (await owner(
    `INSERT INTO employee(id,company_id,site_id,full_name,emp_no,role_code,status,is_expat)
     VALUES (gen_random_uuid(),$1,$2,'Zz Transferred Keeper','TMCL-MW-9901','R13','active',false) RETURNING id`,
    [A, F.SITE.A1])).rows[0].id;
  ids.dev = (await owner(
    `INSERT INTO device(company_id,employee_id,pin_hash,status) VALUES ($1,$2,$3,'active') RETURNING id`,
    [A, ids.emp, C.hashSecret('818181')])).rows[0].id;
});

after(async () => {
  await owner(`DELETE FROM attendance WHERE employee_id=$1`, [ids.emp]);
  await owner(`DELETE FROM session WHERE device_id=$1`, [ids.dev]);
  await owner(`DELETE FROM device WHERE id=$1`, [ids.dev]);
  await owner(`DELETE FROM employee WHERE id=$1`, [ids.emp]);
  await H.stop();
});

test('a TMCL-MW person at site A1 geofences against A1 — the prefix never decides the site', async () => {
  const z = (await owner(`SELECT center_lat, center_lng FROM geofence_zone WHERE name='NM TSF'`)).rows[0];
  const login = await H.req('POST', '/auth/field', { body: { device_id: ids.dev, pin: '818181' } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const r = await H.req('POST', '/attendance/clock-in',
    { token: login.body.token, body: { lat: Number(z.center_lat), lng: Number(z.center_lng), accuracy: 5 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.accepted, true, 'accepted at the LIVE site\'s zone');
  assert.equal(r.body.zone, 'NM TSF', 'the zone is the live site\'s — an MW-prefix inference would have refused this');
});

test('the number survives a site change verbatim (identity is permanent; site is an attribute)', async () => {
  await owner(`UPDATE employee SET site_id=$2 WHERE id=$1`, [ids.emp, F.SITE.A2]);
  const row = (await owner(`SELECT emp_no, site_id FROM employee WHERE id=$1`, [ids.emp])).rows[0];
  assert.equal(row.emp_no, 'TMCL-MW-9901', 'the TMCL number is untouched by the transfer');
  assert.equal(row.site_id, F.SITE.A2, 'only the live site moved');
  await owner(`UPDATE employee SET site_id=$2 WHERE id=$1`, [ids.emp, F.SITE.A1]);
});
