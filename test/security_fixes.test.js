'use strict';
// Regression pins for the bug-hunt findings (severity order). Each asserts the
// exact leak/bypass the reviewers traced is now closed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const auth = require('../src/auth');
const disc = require('../src/disciplinary');
const leave = require('../src/leave');
const docalerts = require('../src/docalerts');
const C = require('../src/crypto');
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

// ── M1: suspending a user / revoking a device kills LIVE sessions ────────────
test('M1: a live session dies the moment its user is suspended (and revives on reactivate)', async () => {
  const login = await H.loginConsole(F.USERS.HR_A); // R03, active
  const token = login.body.token;
  assert.equal((await H.req('GET', '/me/landing', { token })).status, 200, 'live session works');
  try {
    await owner(`UPDATE app_user SET status='suspended' WHERE id=$1`, [F.USERS.HR_A.id]);
    assert.equal((await H.req('GET', '/me/landing', { token })).status, 401,
      'the SAME token is dead once the user is suspended (was 200 before the fix)');
  } finally {
    await owner(`UPDATE app_user SET status='active' WHERE id=$1`, [F.USERS.HR_A.id]);
  }
  assert.equal((await H.req('GET', '/me/landing', { token })).status, 200, 'reactivating restores the session');
});

test('M1: revoking the device kills a live field session', async () => {
  const d = F.DEVICES.FIELD_A;
  const r = await H.req('POST', '/auth/field', { body: { device_id: d.id, pin: d.pin } });
  const token = r.body.token;
  assert.equal((await H.req('GET', '/me/landing', { token })).status, 200, 'field session works');
  try {
    await owner(`UPDATE device SET status='suspended' WHERE id=$1`, [d.id]);
    assert.equal((await H.req('GET', '/me/landing', { token })).status, 401,
      'suspending the device kills the live field session');
  } finally {
    await owner(`UPDATE device SET status='active' WHERE id=$1`, [d.id]);
  }
});

// ── M2: concurrent leave applies for one employee cannot double-spend ─────────
test('M2: two concurrent applies over the balance — exactly one succeeds', async () => {
  // A fresh employee + user at HQ with a small, known annual balance.
  const site = (await owner(`SELECT id FROM site WHERE company_id=$1 LIMIT 1`, [A])).rows[0].id;
  const emp = (await owner(
    `INSERT INTO employee(company_id, site_id, emp_no, full_name, role_code, dept, status)
     VALUES ($1,$2,'TMCL-DS-0001','Dana Spender','R01','Ops','active') RETURNING id`, [A, site])).rows[0].id;
  const uid = (await owner(
    `INSERT INTO app_user(id, company_id, employee_id, email, password_hash, mfa_secret, role_code, status)
     VALUES (gen_random_uuid(),$1,$2,'dana.spender@a.example','x','x','R01','active') RETURNING id`, [A, emp])).rows[0].id;
  const sess = { company_id: A, user_id: uid, role_code: 'R01' };
  try {
    const before = (await leave.balance(sess)).annual.available; // 21 (entitlement, no carry/taken)
    const half = Math.ceil(before / 2) + 1;                      // two of these exceed the balance
    const settled = await Promise.allSettled([
      leave.apply(sess, { leave_type: 'annual', days: half }),
      leave.apply(sess, { leave_type: 'annual', days: half }),
    ]);
    const okCount = settled.filter((s) => s.status === 'fulfilled').length;
    assert.equal(okCount, 1, 'the advisory lock serializes: exactly one apply wins, the other sees the committed balance');
    const taken = (await owner(
      `SELECT coalesce(sum(days),0)::float8 d FROM leave_request WHERE employee_id=$1 AND status<>'declined'`, [emp])).rows[0].d;
    assert.ok(taken <= before, `total approved (${taken}) never exceeds the balance (${before})`);
  } finally {
    await owner('DELETE FROM leave_request WHERE employee_id=$1', [emp]);
    await owner('DELETE FROM app_user WHERE id=$1', [uid]);
    await owner('DELETE FROM employee WHERE id=$1', [emp]);
  }
});

// ── M3: a null-site medical alert fails CLOSED (not visible to every R03) ─────
test('M3: medical alert for a site-less employee is not fanned out to all HR Officers', async () => {
  const admin = { company_id: A, user_id: F.USERS.ADMIN_A.id, role_code: 'R12' };
  const hrA1 = { company_id: A, user_id: F.USERS.HR_A.id, role_code: 'R03' }; // R03 @ A1
  // An employee with NO site (data gap) + an expiring medical document.
  const emp = (await owner(
    `INSERT INTO employee(company_id, site_id, emp_no, full_name, role_code, dept, status)
     VALUES ($1,NULL,'TMCL-NS-0001','Nadia NoSite','R01','Ops','active') RETURNING id`, [A])).rows[0].id;
  const doc = (await owner(
    `INSERT INTO employee_document(company_id, employee_id, kind, name, valid_until)
     VALUES ($1,$2,'medical','Fit-to-work','2026-07-10') RETURNING id`, [A, emp])).rows[0].id;
  try {
    await docalerts.runExpiryAlerts(admin, '2026-06-29');
    const seenBy = async (s) => new Set((await docalerts.listOpen(s)).open.map((a) => a.document_id));
    assert.ok(!(await seenBy(hrA1)).has(doc), 'an R03 at A1 does NOT see a site-less medical alert (fail closed)');
    assert.ok(!(await seenBy(admin)).has(doc), 'nobody sees it — the null-site medical leg is not tenant-wide');
  } finally {
    await owner(`DELETE FROM notification WHERE kind='doc.expiry' AND body->>'document_id'=$1`, [doc]);
    await owner('DELETE FROM employee_document WHERE id=$1', [doc]);
    await owner('DELETE FROM employee WHERE id=$1', [emp]);
  }
});

// ── L1: login does the scrypt work even for an unknown email (no oracle) ──────
test('L1: DUMMY_HASH is a real scrypt hash that always fails verification', () => {
  assert.ok(/^scrypt\$/.test(C.DUMMY_HASH), 'dummy is a syntactically valid scrypt hash');
  assert.equal(C.verifySecret('anything', C.DUMMY_HASH), false, 'nothing verifies against it — but the work still runs');
});

// ── L2: a code from the FUTURE step is never accepted ────────────────────────
test('L2: verifyTotp rejects a future-step code, accepts current and one prior', () => {
  const secret = F.MFA_SECRET;
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 1000 / 30);
  const codeAt = (s) => C.currentTotp(secret, s * 30 * 1000);
  assert.equal(C.verifyTotp(codeAt(step), secret, now), true, 'current step accepted');
  assert.equal(C.verifyTotp(codeAt(step - 1), secret, now), true, 'one prior step accepted (drift)');
  assert.equal(C.verifyTotp(codeAt(step + 1), secret, now), false, 'a FUTURE code is refused (was accepted before)');
});

// ── L4: re-firing the SAME asOf sweep does not double-notify ─────────────────
test('L4: runExpiryAlerts is idempotent for a given asOf', async () => {
  const admin = { company_id: A, user_id: F.USERS.ADMIN_A.id, role_code: 'R12' };
  const doc = (await owner(
    `INSERT INTO employee_document(company_id, employee_id, kind, name, valid_until, permit_type)
     VALUES ($1,$2,'permit','L4 permit','2026-07-10','business') RETURNING id`, [A, F.EMP.CAROL])).rows[0].id;
  try {
    await docalerts.runExpiryAlerts(admin, '2026-06-29');
    await docalerts.runExpiryAlerts(admin, '2026-06-29'); // same date again
    const a = (await owner(`SELECT notify_count FROM doc_alert WHERE document_id=$1`, [doc])).rows[0];
    assert.equal(a.notify_count, 1, 'notify_count not inflated by a same-date re-fire');
    const n = (await owner(
      `SELECT count(*)::int c FROM notification WHERE kind='doc.expiry' AND body->>'document_id'=$1`, [doc])).rows[0].c;
    assert.equal(n, 1, 'exactly one notification, not two');
  } finally {
    await owner(`DELETE FROM notification WHERE kind='doc.expiry' AND body->>'document_id'=$1`, [doc]);
    await owner('DELETE FROM employee_document WHERE id=$1', [doc]);
  }
});

// ── L5: provisioning a duplicate email leaves no orphan employee ─────────────
test('L5: provision-uat-user is atomic — a dup email rolls back the employee', async () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const script = path.join(__dirname, '..', 'scripts', 'provision-uat-user.js');
  const email = 'cecilia.mtweve@a.example'; // reuse an existing seeded email
  await owner(
    `INSERT INTO app_user(id,company_id,employee_id,email,password_hash,mfa_secret,role_code,status)
     VALUES (gen_random_uuid(),$1,NULL,$2,'x','x','R07','active')`, [A, email]).catch(() => {});
  const before = (await owner(`SELECT count(*)::int c FROM employee WHERE company_id=$1 AND email=$2`, [A, email])).rows[0].c;
  try {
    assert.throws(() => execFileSync(process.execPath, [script], {
      env: { ...process.env, UAT_COMPANY: A, UAT_EMAIL: email, UAT_NAME: 'Dup Person', UAT_ROLE: 'R03', UAT_SITE: 'Head Office', UAT_PASSWORD: 'DupPass!2026x' },
      stdio: 'pipe',
    }), 'duplicate email is refused');
    const after = (await owner(`SELECT count(*)::int c FROM employee WHERE company_id=$1 AND email=$2`, [A, email])).rows[0].c;
    assert.equal(after, before, 'no orphan employee row was left behind');
  } finally {
    await owner(`DELETE FROM app_user WHERE company_id=$1 AND email=$2`, [A, email]);
  }
});
