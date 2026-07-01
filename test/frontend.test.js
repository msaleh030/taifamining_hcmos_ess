'use strict';
// F0 — frontend/integration foundation. Parity discipline: these go through the
// real HTTP endpoints (not the services directly). Covers the endpoint middleware
// (auth 401, A2 module guard 403), the /me/landing A2 set, and static serving of
// the production frontend.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { F } = H;

let base;
before(async () => { base = await H.start(); });
after(H.stop);
const raw = (p, opts) => fetch(base + p, opts);

test('F0 auth: login issues a token; /me/landing returns the A2 module set', async () => {
  const login = await H.loginConsole(F.USERS.DIRECTOR_A); // R11
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
  const landing = await H.req('GET', '/me/landing', { token: login.body.token });
  assert.equal(landing.status, 200);
  assert.equal(landing.body.role, 'R11');
  assert.ok(Array.isArray(landing.body.modules) && landing.body.modules.includes('reports'));
});

test('F0 middleware: a protected endpoint returns 401 without a session', async () => {
  const r = await H.req('GET', '/me/landing'); // no token
  assert.equal(r.status, 401);
});

test('F0 middleware: the A2 module guard is enforced at the HTTP layer', async () => {
  const r11 = await H.loginConsole(F.USERS.DIRECTOR_A); // R11 has 'reports'
  const r01 = await H.loginConsole(F.USERS.EMP_A);      // R01 has no 'reports'
  const ok = await H.req('GET', '/reports/summary', { token: r11.body.token });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.modules.includes('reports'));
  const denied = await H.req('GET', '/reports/summary', { token: r01.body.token });
  assert.equal(denied.status, 403, 'a role without the module is refused server-side');
});

test('F0 serves the production frontend (static assets), with traversal blocked', async () => {
  const idx = await raw('/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-type') || '', /text\/html/);
  assert.match(await idx.text(), /<div id="app">/);

  const js = await raw('/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);

  // path traversal outside web/ is refused
  const bad = await raw('/%2e%2e/package.json');
  assert.notEqual(bad.status, 200);
});
