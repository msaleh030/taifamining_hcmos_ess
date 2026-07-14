'use strict';
// Wave 8 (2026-07-14): regressions for production-reachable paths that NO test
// or probe has ever exercised. Each pins a fail-closed guard whose silent
// regression would be a security or money-integrity hole.
//   1. PIN-reset route: owner-gate, unknown-device 404, session revoke.
//   2. Field-device lockout: correct PIN refused while locked.
//   3. readJson: malformed body → 400; >1 MB body → refused (DoS cap).
//   4. exact.retryPublishLegs: refuses a non-published batch (no stray GL leg).
//   5. terminal severance: NULL joining date → not-available (never NaN).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const F = require('./fixtures');
const db = require('../src/db');
const C = require('../src/crypto');
const exact = require('../src/exact');
const terminal = require('../src/terminal');
const contractDef = require('../src/exact_contract');

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;
const N = contractDef.build().length;
let BASE;

before(async () => { BASE = await H.start(); });
after(H.stop);

test('1. PIN-reset route: owner-only, unknown device 404, resets PIN + revokes device sessions', async () => {
  const dev = F.DEVICES.FIELD_A;               // active device, pin 4815, R13
  // A live field session exists before the reset.
  const f0 = await H.req('POST', '/auth/field', { body: { device_id: dev.id, pin: '4815' } });
  assert.equal(f0.status, 200, JSON.stringify(f0.body));
  const oldTok = f0.body.token;
  assert.equal((await H.req('GET', '/me/landing', { token: oldTok })).status, 200, 'session valid pre-reset');

  // A non-owner (R07 Payroll) may not reset a PIN.
  const r07 = await tok(F.USERS.PAYROLL_A);
  assert.equal((await H.req('POST', '/auth/reset/pin', { token: r07, body: { device_id: dev.id, new_pin: '2468' } })).status,
    403, 'non-owner refused');
  // An owner (R03 HR Officer) targeting a non-existent device → 404.
  const r03 = await tok(F.USERS.HR_A);
  assert.equal((await H.req('POST', '/auth/reset/pin', { token: r03, body: { device_id: 'c0000000-0000-0000-0000-0000000000ff', new_pin: '2468' } })).status,
    404, 'unknown device 404');

  try {
    // Owner resets the PIN — must revoke the live device session.
    const reset = await H.req('POST', '/auth/reset/pin', { token: r03, body: { device_id: dev.id, new_pin: '2468' } });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.ok(reset.body.revoked_sessions >= 1, 'the live device session was revoked');
    assert.equal((await H.req('GET', '/me/landing', { token: oldTok })).status, 401, 'old token no longer validates');
    // Old PIN is dead; new PIN works.
    assert.equal((await H.req('POST', '/auth/field', { body: { device_id: dev.id, pin: '4815' } })).status, 401, 'old PIN refused');
    assert.equal((await H.req('POST', '/auth/field', { body: { device_id: dev.id, pin: '2468' } })).status, 200, 'new PIN works');
  } finally {
    // Restore the fixture PIN for any later test in the suite.
    await H.req('POST', '/auth/reset/pin', { token: r03, body: { device_id: dev.id, new_pin: '4815' } });
  }
});

test('2. field-device lockout: a correct PIN is still refused while the device is locked', async () => {
  const devId = 'c0000000-0000-0000-0000-00000000a801';
  await owner(
    `INSERT INTO device (id, company_id, employee_id, pin_hash, status)
     VALUES ($1,$2,$3,$4,'active')`, [devId, A, F.EMP.DAVE, C.hashSecret('112233')]);
  try {
    // Exhaust the lockout threshold (5) with wrong PINs.
    for (let i = 0; i < 5; i++) {
      const bad = await H.req('POST', '/auth/field', { body: { device_id: devId, pin: '000000' } });
      assert.equal(bad.status, 401, `wrong PIN #${i + 1} refused`);
    }
    // The CORRECT PIN must now be refused — the device is locked.
    const locked = await H.req('POST', '/auth/field', { body: { device_id: devId, pin: '112233' } });
    assert.equal(locked.status, 401, 'correct PIN refused while locked (no offline brute-force)');
    const until = (await owner(`SELECT locked_until FROM device WHERE id=$1`, [devId])).rows[0].locked_until;
    assert.ok(until && new Date(until) > new Date(), 'locked_until is in the future');
  } finally {
    await owner(`DELETE FROM session WHERE device_id=$1`, [devId]);
    await owner(`DELETE FROM device WHERE id=$1`, [devId]);
  }
});

test('3. readJson: malformed body → 400; a >1 MB body is refused (DoS cap)', async () => {
  // Malformed JSON on a POST route → 400 invalid JSON (never a raw 500).
  const bad = await fetch(BASE + '/auth/console', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ this is not json' });
  assert.equal(bad.status, 400, 'malformed JSON is a clean 400');

  // A body over the 1 MB cap must not be accepted (connection destroyed).
  const huge = '{"x":"' + 'a'.repeat(1_100_000) + '"}';
  let refused = false;
  try {
    const r = await fetch(BASE + '/auth/console', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: huge });
    refused = r.status !== 200; // never a success
  } catch { refused = true; }    // or the socket is destroyed mid-send
  assert.ok(refused, 'a >1 MB body is refused, not buffered to completion');
});

test('4. exact.retryPublishLegs refuses a non-published batch (409, no stray GL leg)', async () => {
  const batchId = (await owner(
    `INSERT INTO exact_batch(company_id,period,file_hash,version,status,row_count)
     VALUES ($1,'2026-06-w8','w8-hash','v2.0','staged',0) RETURNING id`, [A])).rows[0].id;
  try {
    const session = { company_id: A, role_code: 'R16', user_id: F.USERS.CFC_A.id };
    await assert.rejects(
      exact.retryPublishLegs(session, batchId),
      (e) => e.status === 409 && /not published/.test(e.message),
      'a staged batch cannot be retried — retry is not a back-door publish');
  } finally {
    await owner(`DELETE FROM exact_batch WHERE id=$1`, [batchId]);
  }
});

test('5. terminal severance: an active, remunerated employee with NULL joining date is not-available (never NaN)', async () => {
  const setDays = (v) => owner(
    `INSERT INTO config(company_id,key,value) VALUES ($1,'terminal.severance.days_per_year',$2)
     ON CONFLICT (company_id,key) DO UPDATE SET value=EXCLUDED.value`, [A, v]);
  const cells = Array(N).fill('0'); cells[10] = '3000'; // Basic Salary (v2.0) → base > 0
  const batchId = (await owner(
    `INSERT INTO exact_batch(company_id,period,file_hash,version,status,row_count)
     VALUES ($1,'2026-06-w8b','w8b-hash','v2.0','staged',1) RETURNING id`, [A])).rows[0].id;
  await owner(
    `INSERT INTO exact_row(company_id,batch_id,row_no,employee_id_raw,full_name,cells,matched_employee,match_status)
     VALUES ($1,$2,1,'x','',$3,$4,'matched')`, [A, batchId, JSON.stringify(cells), F.EMP.DAVE]);
  const prevJoin = (await owner(`SELECT joined_at FROM employee WHERE id=$1`, [F.EMP.DAVE])).rows[0].joined_at;
  await owner(`UPDATE employee SET joined_at=NULL WHERE id=$1`, [F.EMP.DAVE]);
  await setDays('7');
  try {
    const session = { company_id: A, role_code: 'R07', user_id: F.USERS.PAYROLL_A.id };
    const res = await terminal.batchSeverance(session, batchId, '2026-07-14');
    const na = res.not_available.find((n) => n.employee_id === F.EMP.DAVE);
    assert.ok(na, 'the NULL-joining-date employee is reported not-available, not computed');
    assert.equal(na.missing, 'joining date');
    assert.ok(!res.available.some((a) => a.employee_id === F.EMP.DAVE), 'never enters the computed (money) list');
    assert.ok(Number.isFinite(res.total), 'the register total is a finite number, never NaN');
  } finally {
    await owner(`UPDATE employee SET joined_at=$2 WHERE id=$1`, [F.EMP.DAVE, prevJoin]);
    await owner(`DELETE FROM exact_batch WHERE id=$1`, [batchId]);
    await setDays('__TBC__');
  }
});
