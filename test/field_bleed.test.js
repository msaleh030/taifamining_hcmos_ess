'use strict';
// Wave 1 (Kira 2026-07-13) — the field-session bleed, D3/D4. A device+PIN
// session is ALWAYS R13, own record only, EVEN when the person holds a
// pay-visible console account. Privilege follows the STRENGTH of the auth, not
// the identity: the worst case is a Payroll Officer's phone reaching bank/tin.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const C = require('../src/crypto');
const { F } = H;

const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
before(H.start);
after(H.stop);

// A person who is a Payroll Officer (R07 — pay-visible) on the console AND has a
// device. Before the fix the device session inherited R07 and leaked pay.
const EMP = 'a0000000-0000-0000-0000-0000000f1e1d';
const USR = 'd0000000-0000-0000-0000-0000000f1e1d';
const DEV = 'c0000000-0000-0000-0000-0000000f1e1d';
const OTHER = 'a0000000-0000-0000-0000-0000000f1e0e';

test('field session is R13 not the console role; own record has NO pay; directory + others 403', async () => {
  await owner(
    `INSERT INTO employee (id, company_id, site_id, full_name, role_code, status)
     VALUES ($1,$2,$3,'Zz Payroll Phone','R07','active'),
            ($4,$2,$3,'Zz Someone Else','R01','active')`,
    [EMP, F.TENANT_A, F.SITE.A1, OTHER]);
  await owner(
    `INSERT INTO employee_pay (employee_id, company_id, basic_salary, bank_name, bank_account, tin, national_id)
     VALUES ($1,$2,1500000,'CRDB','0150-SECRET','123456789','19900101000000000001')`, [EMP, F.TENANT_A]);
  await owner(
    `INSERT INTO app_user (id, company_id, employee_id, email, password_hash, mfa_secret, role_code, status)
     VALUES ($1,$2,$3,'zz.payphone@a.example',$4,$5,'R07','active')`,
    [USR, F.TENANT_A, EMP, C.hashSecret('Consol3!Pass99'), C.MFA_SECRET || 'JBSWY3DPEHPK3PXP']);
  await owner(
    `INSERT INTO device (id, company_id, employee_id, pin_hash, status)
     VALUES ($1,$2,$3,$4,'active')`, [DEV, F.TENANT_A, EMP, C.hashSecret('4321')]);
  try {
    // 1.2 — device+PIN yields R13, NEVER the R07 console role.
    const field = await H.req('POST', '/auth/field', { body: { device_id: DEV, pin: '4321' } });
    assert.equal(field.status, 200, JSON.stringify(field.body));
    assert.equal(field.body.role, 'R13', 'device session is R13, not the person\'s R07');
    const t = field.body.token;

    // 1.6a — directory + other profiles + a console-only surface: ALL 403 (or
    // 403-equivalent). Raw bodies asserted.
    const dir = await H.req('GET', '/employees?limit=1', { token: t });
    assert.equal(dir.status, 403, `directory raw: ${JSON.stringify(dir.body)}`);
    const other = await H.req('GET', `/me/profile/${OTHER}`, { token: t });
    assert.equal(other.status, 403, `another profile raw: ${JSON.stringify(other.body)}`);
    const liability = await H.req('GET', `/reports/register/leave-liability/${F.TENANT_A}`, { token: t });
    assert.equal(liability.status, 403, `liability raw: ${JSON.stringify(liability.body)}`);

    // 1.6b — THE WORST CASE: own record IS reachable (self-service) but every pay
    // field is ABSENT from the RAW JSON, because A3 filters on the R13 session.
    const own = await H.req('GET', `/me/profile/${EMP}`, { token: t });
    assert.equal(own.status, 200, `own profile raw: ${JSON.stringify(own.body)}`);
    for (const k of ['basic_pay', 'bank_account', 'bank_name', 'tin']) {
      assert.ok(!(k in own.body), `${k} MUST be absent from a device session's own profile — raw: ${JSON.stringify(own.body)}`);
    }

    // The SAME person on the console (email+password+MFA) keeps full R07 — the
    // carve-out (1.3): full auth = full role, on any surface.
    const console_ = await H.loginConsole(
      { email: 'zz.payphone@a.example', password: 'Consol3!Pass99' },
      { mfa: C.currentTotp(C.MFA_SECRET || 'JBSWY3DPEHPK3PXP') });
    assert.equal(console_.status, 200, JSON.stringify(console_.body));
    assert.equal(console_.body.role, 'R07', 'full console auth keeps the pay-visible role');
  } finally {
    await owner(`DELETE FROM session WHERE device_id=$1 OR user_id=$2`, [DEV, USR]);
    await owner(`DELETE FROM device WHERE id=$1`, [DEV]);
    await owner(`DELETE FROM app_user WHERE id=$1`, [USR]);
    await owner(`DELETE FROM employee_pay WHERE employee_id=$1`, [EMP]);
    await owner(`DELETE FROM employee WHERE id IN ($1,$2)`, [EMP, OTHER]);
  }
});
