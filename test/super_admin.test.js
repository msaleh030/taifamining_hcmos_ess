'use strict';
// LI-7 — super-admin provisioning. Pins: R12, UNSCOPED (no employee/site
// binding), MFA mandatory, credential stored HASH-ONLY, no railgrid credential
// in the seed, duplicates and weak passwords refused.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const C = require('../src/crypto');
const { provisionSuperAdmin } = require('../scripts/provision-super-admin');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));

before(H.start);
after(H.stop);

test('LI-7 super admin: R12 unscoped, MFA mandatory, hash-only, no seed credential', async () => {
  // No hardcoded admin login: the seed carries NO railgrid credential.
  assert.ok(!Object.values(F.USERS).some((u) => u.email.endsWith('@railgrid.tz')),
    'no railgrid credential in fixtures/seed');

  const email = 'li7-test@railgrid.tz';
  const password = 'S3cure-Passw0rd!';
  const res = await provisionSuperAdmin({ company: A, email, password });
  try {
    // Hash-only + unscoped + R12.
    const row = (await owner(
      `SELECT password_hash, employee_id, role_code FROM app_user WHERE id=$1`, [res.user_id])).rows[0];
    assert.match(row.password_hash, /^scrypt\$/, 'credential stored as an scrypt hash only');
    assert.equal(row.employee_id, null, 'UNSCOPED — no employee/site binding');
    assert.equal(row.role_code, 'R12');

    // Full login (password + TOTP) works; landing is the admin set.
    const login = await H.req('POST', '/auth/console', { body: { email, password, mfa: C.currentTotp(res.secret) } });
    assert.equal(login.status, 200);
    const landing = await H.req('GET', '/me/landing', { token: login.body.token });
    assert.equal(landing.body.role, 'R12');
    assert.ok(landing.body.modules.includes('admin'));

    // MFA is MANDATORY: correct password with a wrong code is refused.
    const noMfa = await H.req('POST', '/auth/console', { body: { email, password, mfa: '000000' } });
    assert.equal(noMfa.status, 401, 'password alone is never enough');

    // No silent admin reset; no weak secrets.
    await assert.rejects(provisionSuperAdmin({ company: A, email, password: 'Another-Secret1!' }), /already exists/);
    await assert.rejects(provisionSuperAdmin({ company: A, email: 'li7-weak@railgrid.tz', password: 'short' }), /12 characters/);
  } finally {
    await owner(`DELETE FROM session WHERE user_id=$1`, [res.user_id]);
    await owner(`DELETE FROM app_user WHERE id=$1`, [res.user_id]);
  }
});

// ── Super-admin SPLIT (Kira 2026-07-13): explicit is_super_admin column, R12
// sysadmin down to rank 60 (IT tier), super at auth.super.rank via the column,
// MFA unconditional for supers even in the setup phase. ──────────────────────
test('SPLIT: column-gated super rank, R12 at 60, unconditional super-MFA', async () => {
  const email = 'split-test@railgrid.tz';
  const password = 'Sup3r-Split-Passw0rd!';
  const res = await provisionSuperAdmin({ company: A, email, password });
  const throwaway = crypto.randomUUID();
  try {
    // (a/b) The flag is explicit and set by provisioning — not employee_id.
    const row = (await owner(
      `SELECT is_super_admin, employee_id FROM app_user WHERE id=$1`, [res.user_id])).rows[0];
    assert.equal(row.is_super_admin, true, 'provisioned super carries the explicit column');

    // (f) MFA is mandatory for supers even when the tenant toggle is OFF.
    await owner(`UPDATE config SET value='0' WHERE company_id=$1 AND key='auth.mfa.required'`, [A]);
    try {
      const noMfa = await H.req('POST', '/auth/console', { body: { email, password } });
      assert.equal(noMfa.status, 401, 'password-only NEVER logs a super in, setup phase or not');
      const withMfa = await H.req('POST', '/auth/console',
        { body: { email, password, mfa: C.currentTotp(res.secret) } });
      assert.equal(withMfa.status, 200, 'password + TOTP still works for the super');
      const normal = await H.loginConsole(F.USERS.HR_A);
      assert.equal(normal.status, 200, 'the setup-phase toggle still applies to NORMAL accounts');
    } finally {
      await owner(`UPDATE config SET value='1' WHERE company_id=$1 AND key='auth.mfa.required'`, [A]);
    }

    // (c/d/e) The lattice: R12 sysadmin (rank 60) can NEITHER reset a super
    // (100) NOR the people-data tier (R11 at 70); R03 (30) cannot reset either
    // R12 target; the SUPER (100, via the column — same R12 role code) CAN
    // reset a plain R12 sysadmin.
    const sysadmin = await H.loginConsole(F.USERS.ADMIN_A); // R12, is_super_admin=false
    const upToSuper = await H.req('POST', '/auth/reset/password', {
      token: sysadmin.body.token, body: { target_user: res.user_id, new_password: 'Hijack!Attempt9' } });
    assert.equal(upToSuper.status, 403, 'sysadmin cannot reset a super (same role code, lower rank)');
    assert.match(String(upToSuper.body.error), /higher-ranked/);

    const upToHoH = await H.req('POST', '/auth/reset/password', {
      token: sysadmin.body.token, body: { target_user: F.USERS.DIRECTOR_A.id, new_password: 'Hijack!Attempt9' } });
    assert.equal(upToHoH.status, 403, 'sysadmin (60) no longer reaches the people-data tier (70)');

    const hr = await H.loginConsole(F.USERS.HR_A); // R03 rank 30
    for (const [label, target] of [['sysadmin', F.USERS.ADMIN_A.id], ['super', res.user_id]]) {
      const r = await H.req('POST', '/auth/reset/password', {
        token: hr.body.token, body: { target_user: target, new_password: 'Hijack!Attempt9' } });
      assert.equal(r.status, 403, `R03 cannot reset the ${label}`);
    }

    // Positive control: the super resets a throwaway plain-R12 sysadmin.
    await owner(
      `INSERT INTO app_user(id, company_id, employee_id, email, password_hash, role_code, status)
       VALUES ($1,$2,NULL,'split-throwaway@a.example',$3,'R12','active')`,
      [throwaway, A, C.hashSecret('Original!Pass99')]);
    const superLogin = await H.req('POST', '/auth/console',
      { body: { email, password, mfa: C.currentTotp(res.secret) } });
    const down = await H.req('POST', '/auth/reset/password', {
      token: superLogin.body.token, body: { target_user: throwaway, new_password: 'SuperSet!Pass99' } });
    assert.equal(down.status, 200, 'super (100, via column) resets a plain R12 (60)');
  } finally {
    await owner(`DELETE FROM session WHERE user_id IN ($1,$2)`, [res.user_id, throwaway]);
    await owner(`DELETE FROM app_user WHERE id IN ($1,$2)`, [res.user_id, throwaway]);
  }
});
