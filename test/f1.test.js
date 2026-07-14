'use strict';
// F1 — directory + profile (maker-checker), proven as INTEGRATION tests through
// the real HTTP endpoints (parity discipline). Covers EMP-01 (directory),
// EMP-02 (site scope), A3 field visibility (absent at the HTTP response),
// EMP-03/SOD-03 (maker-checker), and the F0 middleware deny guard on /employees*.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { F } = H;

const tok = async (u) => (await H.loginConsole(u)).body.token;

before(H.start);
after(H.stop);

// ── EMP-01 + F0 middleware guard on /employees* ─────────────────────────────
test('EMP-01 directory lists via HTTP; directory-denied role 403 via middleware; no token 401', async () => {
  const pay = await tok(F.USERS.PAYROLL_A); // R07, central, directory access
  const list = await H.req('GET', '/employees?limit=25', { token: pay });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.rows) && list.body.rows.length > 0);

  const search = await H.req('GET', '/employees?q=Carol&limit=25', { token: pay });
  assert.ok(search.body.rows.some((r) => /carol/i.test(r.full_name)), 'server-side search works');

  const fin = await tok(F.USERS.CFC_A);     // R16 — in directory.deny.roles (v1.5)
  const denied = await H.req('GET', '/employees', { token: fin });
  assert.equal(denied.status, 403, 'directory-denied role refused by the HTTP-layer deny guard');

  const anon = await H.req('GET', '/employees');
  assert.equal(anon.status, 401, 'no session → 401');
});

// ── EMP-02 site scope at the data layer, over HTTP ──────────────────────────
test('EMP-02 a site-scoped role sees only its site; an out-of-site profile is 404', async () => {
  const sup = await tok(F.USERS.SUP_A); // R02, scoped to SITE A1
  const list = await H.req('GET', '/employees?limit=100', { token: sup });
  assert.equal(list.status, 200);
  for (const r of list.body.rows) assert.equal(r.site_id, F.SITE.A1, 'only Site-A1 rows');

  const out = await H.req('GET', `/employees/${F.EMP.DAVE}`, { token: sup }); // DAVE is SITE A2
  assert.equal(out.status, 404, 'out-of-site profile is not found');
});

// ── A3 visibility — confidential field ABSENT at the HTTP response ───────────
test('A3 confidential fields are ABSENT in the HTTP response for a non-permitted role', async () => {
  const pay = await tok(F.USERS.PAYROLL_A); // R07 sees pay
  const emp = await tok(F.USERS.EMP_A);     // R01 sees no confidential fields

  const permitted = (await H.req('GET', `/employees/${F.EMP.CAROL}`, { token: pay })).body;
  assert.ok('basic_pay' in permitted, 'permitted role sees pay');

  const restricted = (await H.req('GET', `/employees/${F.EMP.CAROL}`, { token: emp })).body;
  assert.ok(!('basic_pay' in restricted), 'absent at the HTTP response — not masked, not null');
  assert.ok(!('osha_status' in restricted), 'medical absent too');
});

// ── EMP-03 / SOD-03 — maker-checker over HTTP ───────────────────────────────
test('EMP-03/SOD-03 a profile edit raises a change request; a second permitted role approves; unauthorised refused', async () => {
  const maker = await tok(F.USERS.HR_A);   // R03 (permitted maker)
  const checker = await tok(F.USERS.HR2_A); // R04 (different permitted checker)
  const newPhone = '0799999999';

  const before = (await H.req('GET', `/employees/${F.EMP.CAROL}`, { token: maker })).body.phone;
  assert.notEqual(before, newPhone);

  // unauthorised edit refused AT THE ENDPOINT (R01 is a directory role but not a maker)
  const emp = await tok(F.USERS.EMP_A);
  const bad = await H.req('POST', `/employees/${F.EMP.CAROL}/change`, { token: emp, body: { field: 'phone', value: newPhone } });
  assert.equal(bad.status, 403, 'non-maker refused at the endpoint');

  // maker raises the change request → pending, stored value unchanged
  const sub = await H.req('POST', `/employees/${F.EMP.CAROL}/change`, { token: maker, body: { field: 'phone', value: newPhone } });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.status, 'pending');
  const mid = (await H.req('GET', `/employees/${F.EMP.CAROL}`, { token: maker })).body;
  assert.equal(mid.phone, before, 'not applied while pending');
  assert.ok(mid.pending_changes.some((c) => c.id === sub.body.id));

  // maker cannot approve their own change (SoD)
  const self = await H.req('POST', `/field-change/${sub.body.id}/approve`, { token: maker });
  assert.equal(self.status, 403, 'maker ≠ checker enforced server-side');

  // a different permitted checker approves → applied
  const ok = await H.req('POST', `/field-change/${sub.body.id}/approve`, { token: checker });
  assert.equal(ok.status, 200);
  const applied = (await H.req('GET', `/employees/${F.EMP.CAROL}`, { token: maker })).body;
  assert.equal(applied.phone, newPhone, 'value applied only on approval');
});
