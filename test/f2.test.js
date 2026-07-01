'use strict';
// F2 — disciplinary action + fan-out, as INTEGRATION tests through the real HTTP
// endpoint. Covers DISC-01..04, SOD-01/02, UNI-06: the atomic fan-out (with the
// fault injected AT THE ENDPOINT layer), suspension-blocks-login, SoD refusals at
// the endpoint, and the fan-out appearing as one linked audit event.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;
const APPROVER = F.USERS.DCHK_A.id; // R04, permitted checker (employee DCHK)

async function counts(empId) {
  const d = (await owner(`SELECT count(*)::int n FROM disciplinary WHERE employee_id=$1`, [empId])).rows[0].n;
  const n = (await owner(`SELECT count(*)::int n FROM notification WHERE employee_id=$1`, [empId])).rows[0].n;
  return { disc: Number(d), notif: Number(n) };
}

before(H.start);
after(H.stop);

// ── DISC-01/04 + UNI-06: atomic fan-out through HTTP; fault injected at endpoint ─
test('DISC-01/04 the fan-out is atomic through the endpoint; a mid-fan-out fault commits nothing', async () => {
  const issuer = await tok(F.USERS.DISS_A); // R05, permitted issuer
  const before = await counts(F.EMP.CAROL);

  // Fault injected AT THE ENDPOINT LAYER (request body → handler, test-only).
  const bad = await H.req('POST', `/employees/${F.EMP.CAROL}/disciplinary`,
    { token: issuer, body: { actionType: 'written', detail: 'boom', approverUserId: APPROVER, faultStep: 'after_ess' } });
  assert.equal(bad.status, 500, 'the faulted fan-out errors');
  const mid = await counts(F.EMP.CAROL);
  assert.equal(mid.disc, before.disc, 'no partial register entry');
  assert.equal(mid.notif, before.notif, 'no orphan notice');

  // Clean call → the whole fan-out commits as one transaction.
  const ok = await H.req('POST', `/employees/${F.EMP.CAROL}/disciplinary`,
    { token: issuer, body: { actionType: 'written', detail: 'unsafe act', approverUserId: APPROVER } });
  assert.equal(ok.status, 200);
  const after = await counts(F.EMP.CAROL);
  assert.equal(after.disc, before.disc + 1, 'register entry');
  assert.ok(after.notif >= before.notif + 2, 'ESS notice + manager/HR console notice');

  const doc = (await owner(`SELECT count(*)::int n FROM employee_document WHERE employee_id=$1 AND kind='warning'`, [F.EMP.CAROL])).rows[0].n;
  assert.ok(Number(doc) >= 1, 'warning letter into My Documents');

  // UNI-06: the fan-out is ONE linked audit event.
  const aud = (await owner(`SELECT count(*)::int n FROM audit WHERE entity='disciplinary' AND entity_id=$1 AND action='disciplinary.action.issue'`, [ok.body.id])).rows[0].n;
  assert.equal(Number(aud), 1, 'audited as one linked event');
});

// ── DISC-03: suspension via the endpoint flips status; the block takes effect ─
test('DISC-03 a suspension issued through the endpoint blocks the subject app-wide', async () => {
  const issuer = await tok(F.USERS.DISS_A);
  const beforeLogin = await H.loginConsole(F.USERS.DSUBJ2_A);
  assert.equal(beforeLogin.status, 200);
  assert.ok(beforeLogin.body.token, 'subject can sign in beforehand');

  const susp = await H.req('POST', `/employees/${F.EMP.DSUBJ2}/disciplinary`,
    { token: issuer, body: { actionType: 'suspension', detail: 'gross misconduct', approverUserId: APPROVER } });
  assert.equal(susp.status, 200);
  assert.equal(susp.body.suspended, true);

  const emp = (await owner(`SELECT status FROM employee WHERE id=$1`, [F.EMP.DSUBJ2])).rows[0];
  assert.equal(emp.status, 'suspended', 'lifecycle status flipped');

  const afterLogin = await H.loginConsole(F.USERS.DSUBJ2_A);
  assert.equal(afterLogin.status, 401, 'the block takes effect — sign-in refused');
});

// ── SOD-01/02: separation of duties enforced at the endpoint ────────────────
test('SOD-01/02 the endpoint refuses self-action, non-distinct checker, and a forbidden issuer', async () => {
  const issuer = await tok(F.USERS.DISS_A); // R05, permitted issuer (employee DISS)

  // Forbidden issuer: R01 is not in disciplinary.issuer.roles → 403 at the HTTP guard.
  const forbidden = await tok(F.USERS.EMP_A);
  const r1 = await H.req('POST', `/employees/${F.EMP.CAROL}/disciplinary`,
    { token: forbidden, body: { actionType: 'written', approverUserId: APPROVER } });
  assert.equal(r1.status, 403, 'forbidden issuer refused at the HTTP layer');

  // Subject cannot be acted on by themselves.
  const r2 = await H.req('POST', `/employees/${F.EMP.DISS}/disciplinary`,
    { token: issuer, body: { actionType: 'written', approverUserId: APPROVER } });
  assert.equal(r2.status, 403, 'cannot act on self');

  // Issuer and checker must be different permitted roles (issuer as own approver → refused).
  const r3 = await H.req('POST', `/employees/${F.EMP.CAROL}/disciplinary`,
    { token: issuer, body: { actionType: 'written', approverUserId: F.USERS.DISS_A.id } });
  assert.equal(r3.status, 403, 'issuer cannot be the checker');
});
