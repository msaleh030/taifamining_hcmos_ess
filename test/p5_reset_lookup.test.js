'use strict';
// P5 — reset-target lookup. Gated on the SAME owner sets as the resets
// (password.reset.owner / pin.reset.owner); each list answers only for its
// own owners; server-side search, minimal fields, capped. The resets
// themselves (rank lattice, session revocation, audit) are pinned by the
// auth suite — this pins the lookup surface the P5 screen stands on.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { F } = H;

before(H.start);
after(H.stop);

const tok = async (u) => (await H.loginConsole(u)).body.token;
const look = (token, q) => H.req('POST', '/auth/reset/lookup', { token, body: { q } });

test('P5-1 an owner role (R03) finds console accounts AND devices; minimal fields only', async () => {
  const hr = await tok(F.USERS.HR_A);
  const r = await look(hr, 'field');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.users.some((u) => u.email === 'field@a.example'), 'account found by email');
  assert.ok(r.body.users.every((u) => u.id && u.email && u.role_code && !('password_hash' in u)), 'minimal fields');
  const d = await look(hr, 'Frank');
  assert.ok(d.body.devices.length >= 1, 'device found by employee name');
  assert.ok(d.body.devices.every((x) => x.id && x.full_name && !('pin_hash' in x)), 'minimal fields');
});

test('P5-2 a NON-owner role is refused (403); short queries are refused (400)', async () => {
  const emp = await tok(F.USERS.EMP_A); // R13 — in neither owner set
  assert.equal((await look(emp, 'field')).status, 403);
  const hr = await tok(F.USERS.HR_A);
  assert.equal((await look(hr, 'f')).status, 400, 'no one-letter directory scraping');
});
