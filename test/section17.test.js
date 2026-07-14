'use strict';
// Section 17 acceptance tests + AC-AUTH-03 (lockout) + audit hash-chain integrity.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

before(H.start);
after(H.stop);

// ── Section 17.1: tenant isolation ─────────────────────────────────────────
test('17.1 authenticated as tenant A, no route or crafted query returns a tenant B row', async () => {
  const a = await H.loginConsole(F.USERS.EMP_A); // tenant A session
  assert.equal(a.status, 200);

  // Via the API: reading tenant B's employee returns not-found, not the row.
  const viaApi = await H.req('GET', `/me/profile/${F.EMP.BOB_B}`, { token: a.body.token });
  assert.equal(viaApi.status, 404);
  assert.ok(!('full_name' in (viaApi.body || {})));

  // Via crafted direct queries on the app connection scoped to A: B is invisible,
  // even when explicitly filtering for B's company_id. RLS, not the UI, is the control.
  await db.withTenant(F.TENANT_A, async (c) => {
    const all = await c.query('SELECT count(*)::int n FROM employee');
    const onlyA = await c.query('SELECT bool_and(company_id=$1) ok FROM employee', [F.TENANT_A]);
    const craft = await c.query('SELECT count(*)::int n FROM employee WHERE company_id=$1', [F.TENANT_B]);
    const bRow  = await c.query('SELECT count(*)::int n FROM app_user WHERE id=$1', [F.USERS.BOB_B.id]);
    assert.ok(all.rows[0].n > 0, 'sees its own rows');
    assert.equal(onlyA.rows[0].ok, true, 'every visible employee belongs to A');
    assert.equal(craft.rows[0].n, 0, 'crafted cross-tenant filter returns nothing');
    assert.equal(bRow.rows[0].n, 0, 'cannot fetch a B user by primary key');
  });
});

// ── Section 17.2: terminated block on BOTH channels ────────────────────────
test('17.2 terminated user with valid console creds AND valid device PIN is refused on both', async () => {
  const console = await H.loginConsole(F.USERS.TERM_A); // valid email+password+MFA
  assert.equal(console.status, 401);

  const d = F.DEVICES.TERM_A; // active device, correct PIN, but owner is terminated
  const field = await H.req('POST', '/auth/field', { body: { device_id: d.id, pin: d.pin } });
  // E14 (2026-07-14): a PROVEN PIN on a terminated account gets the distinct
  // blocked answer (403, no session) so the client can draw the E14 screen;
  // refused either way — never a working session.
  assert.equal(field.status, 403);
  assert.equal(field.body.blocked, 'terminated');
  assert.ok(!field.body.token);
});

// ── Section 17.3: session invalidation on password reset ───────────────────
test('17.3 password reset kills the prior session token (401, no protected data)', async () => {
  const victim = await H.loginConsole(F.USERS.RESET2_A);
  const token = victim.body.token;
  // token is live
  assert.equal((await H.req('GET', '/me/landing', { token })).status, 200);

  // a permitted owner resets the victim's password
  const hr = await H.loginConsole(F.USERS.HR_A);
  const reset = await H.req('POST', '/auth/reset/password', {
    token: hr.body.token, body: { target_user: F.USERS.RESET2_A.id, new_password: 'BrandNew!2026' } });
  assert.equal(reset.status, 200);
  assert.ok(reset.body.revoked_sessions >= 1);

  // prior token is now dead — no protected data
  const after = await H.req('GET', '/me/landing', { token });
  assert.equal(after.status, 401);
  const profile = await H.req('GET', `/me/profile/${F.EMP.ALICE}`, { token });
  assert.equal(profile.status, 401);
});

// ── Section 17.4: RBAC enforced server-side regardless of UI ───────────────
test('17.4 R01 calling an R12-only action is refused server-side; R12 is allowed', async () => {
  const emp = await H.loginConsole(F.USERS.EMP_A);   // R01
  const denied = await H.req('POST', '/action/admin.config.write', { token: emp.body.token });
  assert.equal(denied.status, 403, 'matrix checked server-side even though UI never offered it');

  const admin = await H.loginConsole(F.USERS.ADMIN_A); // R12
  const allowed = await H.req('POST', '/action/admin.config.write', { token: admin.body.token });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.ok, true);
});

// ── AC-AUTH-03: repeated failures lock per config policy; lock is audited ───
test('AC-AUTH-03 repeated failures lock the account per config and audit the lock', async () => {
  const u = F.USERS.LOCK_A;
  const threshold = Number(await db.withOwner(async (c) =>
    (await c.query('SELECT value FROM config WHERE company_id=$1 AND key=$2',
      [u.company, 'auth.lockout.threshold'])).rows[0].value));
  assert.ok(threshold >= 1);

  // exhaust the threshold with wrong passwords
  for (let i = 0; i < threshold; i++) {
    const r = await H.req('POST', '/auth/console', { body: { email: u.email, password: 'wrong', mfa: H.mfaNow() } });
    assert.equal(r.status, 401);
  }
  // now even the CORRECT credentials are refused while locked
  const locked = await H.loginConsole(u);
  assert.equal(locked.status, 401);

  // the lock event is audited
  const audited = await db.withOwner((c) => c.query(
    `SELECT count(*)::int n FROM audit
      WHERE action='auth.lockout' AND entity='app_user' AND entity_id=$1`, [u.id]));
  assert.ok(audited.rows[0].n >= 1, 'lockout is recorded in the audit trail');
});

// ── DoD: audit shows sign-in / reset / lockout on an intact hash chain ──────
test('audit trail contains sign-in, reset and lockout entries on an intact hash chain', async () => {
  await db.withOwner(async (c) => {
    const actions = await c.query(
      `SELECT DISTINCT action FROM audit WHERE company_id=$1`, [F.TENANT_A]);
    const set = new Set(actions.rows.map((r) => r.action));
    for (const a of ['auth.signin', 'auth.reset.password', 'auth.lockout']) {
      assert.ok(set.has(a), `audit has ${a}`);
    }

    // Per-row recompute: each stored hash must equal sha256(prev_hash || payload).
    const recompute = await c.query(`
      SELECT bool_and(hash = encode(sha256(convert_to(prev_hash || concat_ws('|',
        company_id::text, coalesce(actor,''), coalesce(role,''), action,
        coalesce(entity,''), coalesce(entity_id,''), ts::text,
        coalesce(before::text,''), coalesce(after::text,'')), 'UTF8')),'hex')) AS ok
      FROM audit`);
    assert.equal(recompute.rows[0].ok, true, 'no audit row has been tampered with');

    // Chain linkage: prev_hash threads the per-tenant chain; genesis is 64 zeros.
    const chain = await c.query(`
      SELECT seq, company_id, prev_hash,
             lag(hash) OVER (PARTITION BY company_id ORDER BY seq) AS expect
      FROM audit ORDER BY company_id, seq`);
    for (const row of chain.rows) {
      if (row.expect === null) assert.equal(row.prev_hash, '0'.repeat(64), 'genesis prev_hash');
      else assert.equal(row.prev_hash, row.expect, `seq ${row.seq} links to previous`);
    }
  });
});
