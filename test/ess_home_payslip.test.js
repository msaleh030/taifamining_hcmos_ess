'use strict';
// ESS-3 (E2 home completed) + ESS-4 (E6 payslip screen) — frontend pins.
//   • WORDING IS LAW (Kira 2026-07-14): the payslip screen's total reads
//     "Total Pay" and "Net Pay" — the string "Total Allowance" appears in NO
//     locale value the payslip screen uses (the file label is a misnomer).
//   • Both screens render only t() keys, resolved in BOTH languages.
//   • The home quick-action grid carries the payslip tile; Documents /
//     Training / ID card have no backend and are ABSENT (never mocked).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const en = JSON.parse(read('frontend/src/locales/en.json'));
const sw = JSON.parse(read('frontend/src/locales/sw.json'));

test('E6 wording law: Total Pay / Net Pay, never "Total Allowance"', () => {
  assert.equal(en['ess.payslip.totalPay'], 'Total Pay');
  assert.equal(en['ess.payslip.netPay'], 'Net Pay');
  for (const [k, v] of Object.entries(en)) {
    if (k.startsWith('ess.payslip.')) {
      assert.ok(!/total allowance/i.test(String(v)), `${k} must never read "Total Allowance"`);
    }
  }
});

test('payslip + home screens are bilingual: every t() key resolves in EN and SW', () => {
  for (const file of ['frontend/src/screens/Payslip.tsx', 'frontend/src/screens/EssHome.tsx']) {
    const src = read(file);
    const used = [...src.matchAll(/(?<![A-Za-z0-9_.])t\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]);
    assert.ok(used.length >= 6, `${file} renders through t()`);
    for (const k of used) {
      assert.ok(en[k] !== undefined, `EN missing ${k} (${file})`);
      assert.ok(sw[k] !== undefined, `SW missing ${k} (${file})`);
    }
  }
  for (const k of ['ess.payslip.totalPay', 'ess.payslip.netPay', 'ess.payslip.title']) {
    assert.notEqual(en[k], sw[k], `${k} must actually be translated`);
  }
});

test('E2 home: payslip tile present; no-backend tiles (Documents/Training/ID card) absent, never mocked', () => {
  const src = read('frontend/src/screens/EssHome.tsx');
  assert.match(src, /ess\.qaPayslip/, 'payslip quick-action wired');
  assert.match(src, /\/ess\/payslip/, 'tile routes to the payslip screen');
  assert.ok(!/qaDocs|qaTraining|qaId\b/.test(src.replace(/\/\/.*$/gm, '')),
    'Documents/Training/ID card have no backend — absent from the grid (deferred, not mocked)');
});

// ── The bootstrap-identity gap the ESS-3/4 LIVE PROBE caught ────────────────
// A field worker with a device but NO app_user (the normal case for the
// 1,099) could sign in yet got 403 "no employee for user" on every own-data
// endpoint — three private employeeOf copies resolved through app_user only.
// src/identity.js resolves through the session's DEVICE too. Pin it.
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;
const { before, after } = require('node:test');

before(H.start);
after(H.stop);

test('a NO-app_user field session reaches its own leave balance and payslips (device bootstrap)', async () => {
  const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
  const A = F.TENANT_A;
  const ids = {};
  try {
    ids.emp = (await owner(
      `INSERT INTO employee(id,company_id,site_id,full_name,role_code,status,is_expat)
       VALUES (gen_random_uuid(),$1,$2,'Zz Bootstrap','R13','active',false) RETURNING id`,
      [A, F.SITE.A1])).rows[0].id;
    const C = require('../src/crypto');
    ids.dev = (await owner(
      `INSERT INTO device(company_id,employee_id,pin_hash,status) VALUES ($1,$2,$3,'active') RETURNING id`,
      [A, ids.emp, C.hashSecret('909090')])).rows[0].id;
    const login = await H.req('POST', '/auth/field', { body: { device_id: ids.dev, pin: '909090' } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const tok = login.body.token;
    const bal = await H.req('GET', '/leave/balance', { token: tok });
    assert.equal(bal.status, 200, `leave balance resolves via the device: ${JSON.stringify(bal.body)}`);
    const slips = await H.req('GET', '/me/payslips', { token: tok });
    assert.equal(slips.status, 200, `payslips resolve via the device: ${JSON.stringify(slips.body)}`);
    assert.deepEqual(slips.body.periods, [], 'no published pay yet — the honest empty state, not a 403');
  } finally {
    await owner(`DELETE FROM session WHERE device_id=$1`, [ids.dev]);
    await owner(`DELETE FROM device WHERE id=$1`, [ids.dev]);
    if (ids.emp) await owner(`DELETE FROM employee WHERE id=$1`, [ids.emp]);
  }
});
