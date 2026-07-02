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
