'use strict';
// F0 — frontend/integration foundation. Parity discipline: these go through the
// real HTTP endpoints (not the services directly). Covers the endpoint middleware
// (auth 401, A2 module guard 403), the /me/landing A2 set, and static serving of
// the production frontend.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('./helpers');
const { F } = H;

// Import a browser ESM module from web/ inside node: copy it (with its relative
// deps) into a temp dir marked type:module so the ./api.js specifier resolves
// unchanged. api.js has no top-level browser calls, so it imports cleanly.
async function importWeb(entry, deps = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const f of [entry, ...deps]) fs.copyFileSync(path.join(__dirname, '..', 'web', f), path.join(dir, f));
  return import(pathToFileURL(path.join(dir, entry)).href);
}

let base;
before(async () => { base = await H.start(); });
after(H.stop);
const raw = (p, opts) => fetch(base + p, opts);

test('/health is public and confirms DB connectivity (deploy liveness probe)', async () => {
  const r = await raw('/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.db, true);
});

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

// F4 flag-off RENDER: the analytics flag is TENANT-WIDE and gates BOTH the org
// scorecard (C3) and personal My KPIs (E8). This asserts the frontend render of a
// {enabled:false} payload is a DISTINCT disabled panel (module-off explainer +
// enable-pointer) for BOTH screens — never a fall-through to empty/blank, and
// structurally distinct from the empty AND no-permission states.
test('F4 flag-off renders the distinct disabled panel for BOTH C3 and E8', async () => {
  const { kpiView, moduleDisabledView, noPermissionView } = await importWeb('kpi.js', ['api.js']);

  for (const title of ['Scorecard', 'My KPIs']) {
    // Flag off wins even when cards would exist (tenant-wide, overriding role).
    const off = kpiView({ enabled: false, cards: [{ id: 'X', name: 'x' }] }, title);
    assert.match(off, /data-state="module-disabled"/, `${title} flag-off is the disabled panel`);
    assert.match(off, /kpi-disabled/);
    assert.match(off, /switched off/i, 'the panel EXPLAINS the module is off');
    assert.match(off, /enable-pointer/, 'the panel carries an enable-pointer');
    assert.doesNotMatch(off, /data-state="empty"/, 'flag-off is NOT the empty state');
    assert.doesNotMatch(off, /class="cards"/, 'flag-off does not fall through to blank cards');

    // The disabled panel is structurally distinct from empty AND no-permission.
    const empty = kpiView({ enabled: true, cards: [] }, title);
    assert.match(empty, /data-state="empty"/);
    assert.doesNotMatch(empty, /kpi-disabled/, 'empty is NOT the disabled panel');

    const noPerm = noPermissionView(title);
    assert.match(noPerm, /data-state="no-permission"/);
    assert.doesNotMatch(noPerm, /data-state="module-disabled"/, 'no-permission is NOT the disabled panel');
    assert.doesNotMatch(moduleDisabledView(title), /data-state="no-permission"/, 'disabled is NOT no-permission');
  }
});
