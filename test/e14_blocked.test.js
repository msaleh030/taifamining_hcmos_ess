'use strict';
// E14 — ESS-2/P7 (Kira 2026-07-14): blocked / suspended / terminated.
// "A terminated employee who can still clock in on a mine site is a real
// problem." Pins, in order:
//   1. AUTH-04 stands: a WRONG PIN learns nothing — generic 401 — even when
//      the account is suspended (no status oracle for guessers).
//   2. A CORRECT PIN on a suspended account → 403 {blocked:'suspended'}, no
//      session (the client draws the E14 suspended screen).
//   3. A CORRECT PIN on a TERMINATED EMPLOYEE → 403 {blocked:'terminated'} —
//      including the no-app_user bootstrap path, which previously walked
//      straight through (auth_lookup_device never read employee.status).
//   4. A LIVE field session dies the moment the employee is suspended or
//      terminated (auth_lookup_session employee gate, migration 039) — the
//      mine-gate hole: no lingering token can clock in.
//   5. The blocked screen ships BILINGUAL: EN+SW locale keys present and
//      translated; Blocked.tsx renders only t() keys.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

const A = F.TENANT_A;
const D = F.DEVICES.FIELD_A;                    // device of EMP.FIELDA (PIN 4815)
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const setUser = (st) => owner(`UPDATE app_user SET status=$2 WHERE id=$1`, [F.USERS.FIELD_A.id, st]);
const setEmp = (st) => owner(`UPDATE employee SET status=$2 WHERE id=$1`, [F.EMP.FIELDA, st]);
const login = (pin) => H.req('POST', '/auth/field', { body: { device_id: D.id, pin } });

before(H.start);
after(async () => { await setUser('active'); await setEmp('active'); await H.stop(); });

test('E14-1 AUTH-04 stands: wrong PIN on a suspended account is a GENERIC 401 — no status oracle', async () => {
  await setUser('suspended');
  try {
    const r = await login('0000');
    assert.equal(r.status, 401, 'wrong PIN → 401');
    assert.equal(r.body.error, 'authentication failed', 'generic — never names the factor or the status');
    assert.ok(!('blocked' in r.body), 'no blocked hint without a proven identity');
  } finally { await setUser('active'); }
});

test('E14-2 correct PIN + suspended app_user → 403 blocked:"suspended", NO session', async () => {
  await setUser('suspended');
  try {
    const r = await login(D.pin);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.blocked, 'suspended', 'the DISTINCT suspended answer');
    assert.ok(!r.body.token, 'never a working session');
  } finally { await setUser('active'); }
  const ok = await login(D.pin);
  assert.equal(ok.status, 200, 'lift the suspension → sign-in works again (reversible)');
});

test('E14-3 correct PIN + TERMINATED employee → 403 blocked:"terminated" (the mine-gate hole, closed)', async () => {
  await setEmp('terminated');
  try {
    const r = await login(D.pin);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.blocked, 'terminated', 'terminated is drawn distinctly from suspended');
    assert.ok(!r.body.token, 'no session for a leaver');
  } finally { await setEmp('active'); }
});

test('E14-3b terminated employee blocks the NO-app_user bootstrap path too', async () => {
  // Detach the app_user linkage temporarily: user_status is NULL on lookup and
  // the old code allowed the login outright — employee.status must gate alone.
  await owner(`UPDATE app_user SET employee_id=NULL WHERE id=$1`, [F.USERS.FIELD_A.id]);
  await setEmp('terminated');
  try {
    const r = await login(D.pin);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.blocked, 'terminated');
  } finally {
    await setEmp('active');
    await owner(`UPDATE app_user SET employee_id=$2 WHERE id=$1`, [F.USERS.FIELD_A.id, F.EMP.FIELDA]);
  }
});

test('E14-4 a LIVE field session dies when the employee is suspended (no lingering clock-in token)', async () => {
  const ok = await login(D.pin);
  assert.equal(ok.status, 200);
  const token = ok.body.token;
  const before1 = await H.req('GET', '/me/landing', { token });
  assert.equal(before1.status, 200, 'session works while active');
  await setEmp('suspended');
  try {
    const after1 = await H.req('GET', '/me/landing', { token });
    assert.equal(after1.status, 401, 'the live session is dead the moment the worker is suspended');
  } finally { await setEmp('active'); }
});

test('E14-5 the blocked screen ships bilingual and renders only locale keys', () => {
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'frontend/src/locales/en.json'), 'utf8'));
  const sw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'frontend/src/locales/sw.json'), 'utf8'));
  const KEYS = ['title', 'sub', 'suspT', 'suspB', 'termT', 'termB', 'suspWhy', 'termWhy', 'contactHr', 'contactHint', 'back']
    .map((k) => `ess.blocked.${k}`);
  for (const k of KEYS) {
    assert.ok(en[k], `EN missing ${k}`);
    assert.ok(sw[k], `SW missing ${k}`);
  }
  // Translated where translation applies (status chips share the code names).
  for (const k of ['ess.blocked.suspT', 'ess.blocked.termT', 'ess.blocked.suspB', 'ess.blocked.termB', 'ess.blocked.contactHr']) {
    assert.notEqual(en[k], sw[k], `${k} must actually be translated`);
  }
  // The screen uses t() keys only — every literal t('...') resolves in BOTH languages.
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/screens/Blocked.tsx'), 'utf8');
  const used = [...src.matchAll(/(?<![A-Za-z0-9_.])t\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 8, 'Blocked.tsx renders through t()');
  for (const k of used) {
    assert.ok(en[k], `EN missing used key ${k}`);
    assert.ok(sw[k], `SW missing used key ${k}`);
  }
});
