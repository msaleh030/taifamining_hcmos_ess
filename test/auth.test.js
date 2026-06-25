'use strict';
// AC-AUTH-01/02/04/05/06 + A3 confidential fields. (AC-AUTH-03 lockout and the
// four Section 17 tests live in section17.test.js.)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

before(H.start);
after(H.stop);

// ── AC-AUTH-01: console verifies email + password + MFA, lands per A2 ───────
test('AUTH-01 console sign-in with all three factors succeeds and returns A2 landing', async () => {
  const r = await H.loginConsole(F.USERS.EMP_A);
  assert.equal(r.status, 200);
  assert.ok(r.body.token, 'issues a session token');
  assert.equal(r.body.role, 'R01');
  assert.equal(r.body.route, '/dashboard');
  assert.ok(r.body.landing.modules.includes('dashboard'));
});

// ── AC-AUTH-04: any failure is generic and never names the failing factor ──
test('AUTH-04 wrong password, wrong MFA, and missing fields all return the SAME generic error', async () => {
  const u = F.USERS.EMP_A;
  const badPw  = await H.req('POST', '/auth/console', { body: { email: u.email, password: 'nope', mfa: H.mfaNow() } });
  const badMfa = await H.req('POST', '/auth/console', { body: { email: u.email, password: u.password, mfa: '000000' } });
  const missing = await H.req('POST', '/auth/console', { body: { email: u.email } });
  const unknown = await H.req('POST', '/auth/console', { body: { email: 'nobody@a.example', password: 'x', mfa: '123456' } });

  for (const r of [badPw, badMfa, missing, unknown]) {
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'authentication failed');
    // must not leak which factor failed
    assert.doesNotMatch(JSON.stringify(r.body), /password|mfa|otp|email|token|factor/i);
  }
});

// ── AC-AUTH-04: terminated user refused on console even with valid creds ────
test('AUTH-04 terminated user is refused at console', async () => {
  const r = await H.loginConsole(F.USERS.TERM_A);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'authentication failed');
});

// ── AC-AUTH-02: field device + PIN ─────────────────────────────────────────
test('AUTH-02 field sign-in with registered device + correct PIN succeeds', async () => {
  const d = F.DEVICES.FIELD_A;
  const r = await H.req('POST', '/auth/field', { body: { device_id: d.id, pin: d.pin } });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal(r.body.role, 'R13');
});

test('AUTH-02 unregistered device is refused server-side', async () => {
  const r = await H.req('POST', '/auth/field', {
    body: { device_id: '00000000-0000-0000-0000-0000000000ff', pin: '4815' } });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'authentication failed');
});

test('AUTH-02 wrong PIN is refused', async () => {
  const d = F.DEVICES.FIELD_A;
  const r = await H.req('POST', '/auth/field', { body: { device_id: d.id, pin: '0000' } });
  assert.equal(r.status, 401);
});

// ── AC-AUTH-02: offline queue dedupes on sync via idempotency key ──────────
test('AUTH-02 replayed offline field auth dedupes (one session, not two)', async () => {
  const d = F.DEVICES.FIELD_A;
  const key = 'offline-' + Date.now();
  const first  = await H.req('POST', '/auth/field', { body: { device_id: d.id, pin: d.pin, idempotency_key: key } });
  const second = await H.req('POST', '/auth/field', { body: { device_id: d.id, pin: d.pin, idempotency_key: key } });

  assert.equal(first.status, 200);
  assert.equal(first.body.deduped, false);
  assert.equal(second.status, 200);
  assert.equal(second.body.deduped, true, 'replay is recognised as already processed');
  assert.equal(second.body.session_id, first.body.session_id, 'same session, not a new one');

  // Confirm exactly one idempotency record exists for the key.
  const n = await db.withOwner((c) =>
    c.query('SELECT count(*)::int AS n FROM idempotency WHERE key=$1', [key]));
  assert.equal(n.rows[0].n, 1);
});

// ── AC-AUTH-06: /me/landing returns only permitted modules (least privilege) ─
test('AUTH-06 landing exposes only role-permitted modules, never a forbidden area', async () => {
  const admin = await H.loginConsole(F.USERS.ADMIN_A);
  const la = await H.req('GET', '/me/landing', { token: admin.body.token });
  assert.equal(la.status, 200);
  assert.ok(la.body.modules.includes('admin'));
  assert.ok(!la.body.modules.includes('leave'), 'admin role does not land on employee leave');

  const emp = await H.loginConsole(F.USERS.EMP_A);
  const le = await H.req('GET', '/me/landing', { token: emp.body.token });
  assert.ok(le.body.modules.includes('dashboard'));
  assert.ok(!le.body.modules.includes('admin'), 'R01 never sees admin');
});

// ── AC-AUTH-05: password reset — permitted owner only; rotates + revokes ────
test('AUTH-05 password reset is refused to a non-owner role', async () => {
  const emp = await H.loginConsole(F.USERS.EMP_A); // R01, not in password.reset.owner
  const r = await H.req('POST', '/auth/reset/password', {
    token: emp.body.token, body: { target_user: F.USERS.RESET_A.id, new_password: 'whatever' } });
  assert.equal(r.status, 403);
});

test('AUTH-05 password reset by a permitted owner rotates the credential', async () => {
  const hr = await H.loginConsole(F.USERS.HR_A); // R03 ∈ password.reset.owner
  const newPw = 'Rotated!Pass99';
  const r = await H.req('POST', '/auth/reset/password', {
    token: hr.body.token, body: { target_user: F.USERS.RESET_A.id, new_password: newPw } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  // New credential works; old one no longer does.
  const withNew = await H.loginConsole(F.USERS.RESET_A, { password: newPw });
  assert.equal(withNew.status, 200);
  const withOld = await H.loginConsole(F.USERS.RESET_A); // original password
  assert.equal(withOld.status, 401);
});

// ── A3: confidential fields enforced server-side; forbidden fields ABSENT ───
test('A3 payroll role (R07) sees pay/bank + disciplinary but not medical/permits', async () => {
  const pay = await H.loginConsole(F.USERS.PAYROLL_A);
  const r = await H.req('GET', `/me/profile/${F.EMP.CAROL}`, { token: pay.body.token });
  assert.equal(r.status, 200);
  assert.ok('pay_grade' in r.body && 'bank_account' in r.body);
  assert.ok('disciplinary' in r.body);
  assert.ok(!('medical_notes' in r.body), 'medical omitted (absent, not masked)');
  assert.ok(!('permits' in r.body));
});

test('A3 HSE role (R06) sees medical/permits + disciplinary but not pay/bank', async () => {
  const hse = await H.loginConsole(F.USERS.HSE_A);
  const r = await H.req('GET', `/me/profile/${F.EMP.CAROL}`, { token: hse.body.token });
  assert.equal(r.status, 200);
  assert.ok('medical_notes' in r.body && 'permits' in r.body);
  assert.ok('disciplinary' in r.body);
  assert.ok(!('pay_grade' in r.body) && !('bank_account' in r.body));
});

test('A3 ordinary employee (R01) sees no confidential fields at all', async () => {
  const emp = await H.loginConsole(F.USERS.EMP_A);
  const r = await H.req('GET', `/me/profile/${F.EMP.CAROL}`, { token: emp.body.token });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['full_name', 'id']);
});
