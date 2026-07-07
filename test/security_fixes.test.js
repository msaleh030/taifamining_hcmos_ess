'use strict';
// Regression pins for the bug-hunt findings (severity order). Each asserts the
// exact leak/bypass the reviewers traced is now closed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const auth = require('../src/auth');
const disc = require('../src/disciplinary');
const { Client, Pool } = require('../src/pg');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));

before(H.start);
after(H.stop);

// ── H1: /me/profile/:id carries the directory-deny + site-scope gates ────────
test('H1: readProfile denies directory-denied roles and out-of-site reads', async () => {
  // R03 (site-scoped) bound to SITE A1 cannot read an employee at SITE A2.
  const hrA1 = { company_id: A, user_id: F.USERS.HR_A.id, role_code: 'R03' }; // employee ALICE @ A1
  await assert.rejects(auth.readProfile(hrA1, F.EMP.DAVE), /not found/,
    'site-bound R03 gets 404 for an out-of-site profile (no confidential leak)');
  // Same-site read still works (regression guard).
  const ownSite = await auth.readProfile(hrA1, F.EMP.CAROL); // Carol @ A1
  assert.ok(ownSite && ownSite.full_name, 'same-site profile still returned');

  // A directory-denied finance role (R15) cannot read ANY profile here —
  // exactly as GET /employees/:id already refuses it.
  const fin = { company_id: A, user_id: F.USERS.FINMGR_A.id, role_code: 'R15' };
  await assert.rejects(auth.readProfile(fin, F.EMP.CAROL), /forbidden/,
    'directory-denied R15 cannot pull pay/bank via /me/profile');
});

// ── H2: field (device+PIN) login refuses a suspended user ────────────────────
test('H2: suspended user cannot field-login even with a valid device + PIN', async () => {
  const d = F.DEVICES.FIELD_A; // EMP.FIELDA, app_user FIELD_A (R13), active
  try {
    // Console-equivalent hold: suspend the app_user.
    await owner(`UPDATE app_user SET status='suspended' WHERE id=$1`, [F.USERS.FIELD_A.id]);
    const r = await H.req('POST', '/auth/field', { body: { device_id: d.id, pin: d.pin } });
    assert.equal(r.status, 401, 'suspended user is refused at the kiosk (was 200 before the fix)');
  } finally {
    await owner(`UPDATE app_user SET status='active' WHERE id=$1`, [F.USERS.FIELD_A.id]);
  }
  // Sanity: active again → login succeeds.
  const ok = await H.req('POST', '/auth/field', { body: { device_id: d.id, pin: d.pin } });
  assert.equal(ok.status, 200, 'active user still logs in');
});

// ── H3: disciplinary issuer cannot target an out-of-site employee ────────────
test('H3: site-bound disciplinary issuer is 404 for an out-of-site subject', async () => {
  const issuer = { company_id: A, user_id: F.USERS.DISS_A.id, role_code: 'R06' }; // Ivy @ A1 (site-scoped)
  await assert.rejects(
    disc.issueAction(issuer, { employeeId: F.EMP.DAVE, actionType: 'written', detail: 'x', approverUserId: F.USERS.DCHK_A.id }),
    /employee not found/, 'out-of-site subject 404s before any read/write');
});

// ── H4: pg client settles the in-flight query on failure; pool drops dead idle
test('H4: _fail rejects the in-flight query (no hang) and marks closed', async () => {
  const c = new Client({ host: '127.0.0.1', port: 5432, ssl: 'disable' });
  let rejected = null;
  c._cur = { reject: (e) => { rejected = e; } };  // simulate an executing query
  c._fail(new Error('connection closed'));
  assert.ok(rejected && /connection closed/.test(rejected.message), 'in-flight query rejected, not left pending');
  assert.equal(c._cur, null, 'current query cleared');
  assert.equal(c._closed, true, 'client marked closed');
});

test('H4: pool.acquire discards a dead idle connection and frees its slot', async () => {
  const p = new Pool({ host: '127.0.0.1', port: 5432, ssl: 'disable' }, 4);
  const live = { _closed: false }, dead = { _closed: true };
  p.size = 2; p.idle = [live, dead];               // dead on top of the stack
  const got = await p.acquire();
  assert.equal(got, live, 'the live connection is handed out, not the dead one');
  assert.equal(p.size, 1, 'the dead connection freed its pool slot');
});
