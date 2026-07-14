'use strict';
// Shared KIOSK (Kira rulings 2026-07-14). Pins the WHOLE posture:
//   1. the device enrols to a SITE — the roster answers only for an enrolled
//      ACTIVE kiosk and lists only that site's active workers;
//   2. the PIN identifies the PERSON (per-person lockout, wrong PIN generic);
//   3. the session is CLOCK-ONLY (server-side: leave/payslip/landing → 403)
//      and SINGLE-USE (dead the instant the punch commits);
//   4. PHOTO-ON-PUNCH records, never blocks: with a photo the binary lands on
//      disk (path in the DB, never base64); without one the punch still
//      succeeds and the row is FLAGGED photo_missing;
//   5. E14 holds on the kiosk too: suspended/terminated + correct PIN → the
//      distinct blocked answer, no session;
//   6. C20 check 6 surfaces no-photo kiosk punches BY SITE with counts;
//   7. the person-picker ships bilingual (the ordered EN/SW pair verbatim).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const db = require('../src/db');
const C = require('../src/crypto');
const controls = require('../src/controls');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const PHOTO_DIR = path.join(__dirname, '..', 'var', 'test-punch-photos');
const JPEG = 'data:image/jpeg;base64,' + Buffer.alloc(256, 7).toString('base64');
const ids = {};

before(async () => {
  await H.start();
  await owner(`INSERT INTO config(company_id,key,value) VALUES ($1,'storage.local.root',$2)
               ON CONFLICT (company_id,key) DO UPDATE SET value=EXCLUDED.value`, [A, PHOTO_DIR]);
  ids.kiosk = (await owner(
    `INSERT INTO device(company_id,site_id,kind,status) VALUES ($1,$2,'kiosk','active') RETURNING id`,
    [A, F.SITE.A1])).rows[0].id;
  await owner(`INSERT INTO field_pin(company_id,employee_id,pin_hash) VALUES ($1,$2,$3)
               ON CONFLICT (employee_id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash, failed_count=0, locked_until=NULL`,
    [A, F.EMP.FIELDA, C.hashSecret('246810')]);
  ids.fresh = (await owner(
    `INSERT INTO employee(id,company_id,site_id,full_name,role_code,status,is_expat)
     VALUES (gen_random_uuid(),$1,$2,'Zz Kiosk Fresh','R13','active',false) RETURNING id`,
    [A, F.SITE.A1])).rows[0].id;
  await owner(`INSERT INTO field_pin(company_id,employee_id,pin_hash) VALUES ($1,$2,$3)`,
    [A, ids.fresh, C.hashSecret('135790')]);
});

after(async () => {
  await owner(`UPDATE employee SET status='active' WHERE id=$1`, [F.EMP.FIELDA]);
  await owner(`DELETE FROM stored_object WHERE kind='punch-photo'`);
  await owner(`DELETE FROM attendance WHERE via='kiosk'`);
  await owner(`DELETE FROM session WHERE kind='kiosk'`);
  await owner(`DELETE FROM field_pin WHERE employee_id IN ($1,$2)`, [F.EMP.FIELDA, ids.fresh]);
  await owner(`DELETE FROM device WHERE id=$1`, [ids.kiosk]);
  await owner(`DELETE FROM employee WHERE id=$1`, [ids.fresh]);
  await owner(`DELETE FROM config WHERE company_id=$1 AND key='storage.local.root'`, [A]);
  fs.rmSync(PHOTO_DIR, { recursive: true, force: true });
  await H.stop();
});

const login = (emp, pin) => H.req('POST', '/auth/kiosk', { body: { device_id: ids.kiosk, employee_id: emp, pin } });
const punch = (token, body) => H.req('POST', '/kiosk/punch', { token, body });

test('K1 roster answers only for an enrolled kiosk, with the site\'s active workers', async () => {
  const r = await H.req('POST', '/kiosk/roster', { body: { device_id: ids.kiosk } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.workers.length > 0, 'site roster answers');
  // Big sites (5,200 seeded here) search SERVER-SIDE past the cap.
  const found = await H.req('POST', '/kiosk/roster', { body: { device_id: ids.kiosk, q: 'Frank Field' } });
  assert.ok(found.body.workers.some((w) => w.employee_id === F.EMP.FIELDA), 'server-side search finds the worker');
  assert.ok(r.body.workers.every((w) => w.full_name && 'emp_no' in w && !('phone' in w)), 'minimal fields only');
  // A PERSONAL device id is not a kiosk — generic 401, no roster oracle.
  const personal = await H.req('POST', '/kiosk/roster', { body: { device_id: F.DEVICES.FIELD_A.id } });
  assert.equal(personal.status, 401);
  assert.equal(personal.body.error, 'authentication failed');
});

test('K2 wrong PIN → generic 401, counted per PERSON (field_pin), not per device', async () => {
  const r = await login(F.EMP.FIELDA, '000000');
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'authentication failed');
  const n = (await owner(`SELECT failed_count FROM field_pin WHERE employee_id=$1`, [F.EMP.FIELDA])).rows[0];
  assert.ok(n.failed_count >= 1, 'per-person failure counter moved');
});

test('K3 correct PIN → single-use kiosk token; punch WITH photo attributes to the person, binary on disk', async () => {
  const ok = await login(F.EMP.FIELDA, '246810');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.kind, 'kiosk');
  const p = await punch(ok.body.token, { direction: 'in', photo: JPEG });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.photo_recorded, true);
  const row = (await owner(
    `SELECT employee_id, via, direction, photo_path, photo_missing FROM attendance WHERE id=$1`,
    [p.body.attendance_id])).rows[0];
  assert.equal(row.employee_id, F.EMP.FIELDA, 'the punch is attributed to the PIN\'d person');
  assert.equal(row.via, 'kiosk');
  assert.equal(row.photo_missing, false);
  assert.ok(row.photo_path && !row.photo_path.startsWith('data:'), 'a PATH, never a data URL in the DB');
  assert.ok(fs.existsSync(row.photo_path), 'the photo binary is at rest on disk');
  // The ONE storage foundation carries it: metadata row with integrity hash
  // and an HONEST scan status (clamd absent in CI → 'pending'/'unavailable').
  const obj = (await owner(
    `SELECT kind, owner_entity, owner_id, sha256, scan_status FROM stored_object
      WHERE owner_entity='attendance' AND owner_id=$1`, [p.body.attendance_id])).rows[0];
  assert.ok(obj, 'stored_object metadata row exists');
  assert.equal(obj.kind, 'punch-photo');
  assert.match(obj.sha256, /^[0-9a-f]{64}$/, 'integrity hash recorded');
  assert.ok(['pending', 'clean', 'unavailable'].includes(obj.scan_status), 'scan status recorded honestly');
  // SINGLE-USE: the session died with the punch.
  const again = await punch(ok.body.token, { direction: 'out', photo: null });
  assert.equal(again.status, 401, 'a second request on the same session is rejected');
});

test('K4 camera suppressed → the punch STILL SUCCEEDS and is FLAGGED no-photo (records, never blocks)', async () => {
  const ok = await login(F.EMP.FIELDA, '246810');
  const p = await punch(ok.body.token, { direction: 'out', photo: null });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.photo_recorded, false);
  assert.equal(p.body.flagged, 'no photo / review');
  const row = (await owner(`SELECT photo_missing, photo_path FROM attendance WHERE id=$1`,
    [p.body.attendance_id])).rows[0];
  assert.equal(row.photo_missing, true);
  assert.equal(row.photo_path, null);
});

test('K5 a kiosk session is CLOCK-ONLY: leave, payslip and landing are 403 server-side', async () => {
  const ok = await login(F.EMP.FIELDA, '246810');
  for (const [method, p] of [['GET', '/leave/balance'], ['GET', '/me/payslips'], ['GET', '/me/landing'], ['GET', '/employees']]) {
    const r = await H.req(method, p, { token: ok.body.token });
    assert.equal(r.status, 403, `${p} must be refused: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'kiosk session is clock-only');
  }
  // burn the session cleanly
  await punch(ok.body.token, { direction: 'in', photo: JPEG });
});

test('K6 E14 on the kiosk: suspended worker + correct PIN → distinct blocked answer, no session', async () => {
  await owner(`UPDATE employee SET status='suspended' WHERE id=$1`, [F.EMP.FIELDA]);
  try {
    const r = await login(F.EMP.FIELDA, '246810');
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.blocked, 'suspended');
    assert.ok(!r.body.token);
  } finally {
    await owner(`UPDATE employee SET status='active' WHERE id=$1`, [F.EMP.FIELDA]);
  }
});

test('K7 clock-out only closes an OPEN shift (409 with no prior clock-in)', async () => {
  const ok = await login(ids.fresh, '135790');
  const r = await punch(ok.body.token, { direction: 'out', photo: null });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, 'not clocked in');
});

test('K8 C20 check 6 surfaces no-photo kiosk punches BY SITE with counts', async () => {
  const session = { company_id: A, user_id: F.USERS.ADMIN_A.id, role_code: 'R12' };
  const out = await controls.runControls(session);
  const check = out.checks.find((x) => x.check === 'kiosk.photo_missing');
  assert.ok(check, 'check present');
  assert.ok(check.checked, 'population: kiosk punches exist in the window');
  assert.equal(check.pass, false, 'the flagged punch from K4 is an offender');
  const site = check.offenders.find((o) => o.no_photo_punches >= 1);
  assert.ok(site && site.site, `grouped by site with counts: ${JSON.stringify(check.offenders)}`);
});

test('K9 the person-picker ships bilingual — the ordered pair verbatim, every key in EN and SW', () => {
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'frontend/src/locales/en.json'), 'utf8'));
  const sw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'frontend/src/locales/sw.json'), 'utf8'));
  assert.equal(en['kiosk.title'], 'Shared kiosk, pick who is signing in');
  assert.equal(sw['kiosk.title'], 'Kioski cha pamoja, chagua anayeingia');
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/screens/Kiosk.tsx'), 'utf8');
  const used = [...src.matchAll(/(?<![A-Za-z0-9_.])t\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 10, 'Kiosk.tsx renders through t()');
  for (const k of used) {
    assert.ok(en[k] !== undefined, `EN missing ${k}`);
    assert.ok(sw[k] !== undefined, `SW missing ${k}`);
  }
});
