'use strict';
// F7 — controls/alerts/support/policy, as INTEGRATION tests through the real HTTP
// endpoints. Controls (the all-clear evidence grid) is DEFERRED until Design lands
// spec #2, so this covers the three ungated modules with their faithful guards:
//   • Alerts (DA-1/DA-2): compliance-owner guard (alerts.view.roles); each alert
//     routes to its DA-2 role. A non-owner role is refused.
//   • Support (SUP-01..04): raise is self-service; a ticket is scoped to its
//     RAISER + the support role; only the support role drives the lifecycle.
//   • Policy (POL-01..04): read + ack self-service; publish is admin; the
//     outstanding-acks report is reports-only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;

before(H.start);
after(H.stop);

// ── Alerts (DOC-01): compliance-owner guard + DA-2 routing at the endpoint ───
test('alerts: endpoint guarded to document-compliance owners; expiring doc routes to its DA-2 role', async () => {
  const emp = await tok(F.USERS.EMP_A);     // R01 — NOT a document-compliance owner
  const admin = await tok(F.USERS.ADMIN_A); // R12 — in alerts.view.roles

  // Guard: a non-owner role cannot run the sweep or read alerts.
  assert.equal((await H.req('POST', '/alerts/run', { token: emp, body: { asOf: '2026-06-29' } })).status, 403);
  assert.equal((await H.req('GET', '/alerts', { token: emp })).status, 403);

  const docId = (await owner(
    `INSERT INTO employee_document(company_id,employee_id,kind,name,valid_until)
     VALUES ($1,$2,'permit','F7 permit',$3) RETURNING id`, [A, F.EMP.CAROL, '2026-07-29'])).rows[0].id;
  try {
    const run = await H.req('POST', '/alerts/run', { token: admin, body: { asOf: '2026-06-29' } });
    assert.equal(run.status, 200);
    const raised = run.body.raised.find((x) => x.document_id === docId);
    assert.ok(raised, 'the expiring permit raised an alert');
    assert.equal(raised.notify_role, 'R06', 'routed to the DA-2 permit role (registry)');

    const list = await H.req('GET', '/alerts', { token: admin });
    assert.equal(list.status, 200);
    assert.ok(list.body.open.some((a) => a.document_id === docId && a.notify_role === 'R06'), 'alert visible on the dashboard');
  } finally {
    await owner(`DELETE FROM notification WHERE kind='doc.expiry' AND body->>'document_id'=$1`, [docId]);
    await owner(`DELETE FROM employee_document WHERE id=$1`, [docId]); // cascades doc_alert
  }
});

// ── Support (SUP-01..04): raise self-service; scoped to raiser + support role ─
test('support: raise is self-service; a ticket is scoped to raiser + support role; only support drives lifecycle', async () => {
  const emp = await tok(F.USERS.EMP_A);     // R01 raiser (employee ALICE)
  const dave = await tok(F.USERS.SITE2_A);  // R01 different employee (DAVE)
  const admin = await tok(F.USERS.ADMIN_A); // R12 = support.agent.roles

  const raised = await H.req('POST', '/support/tickets', { token: emp, body: { subject: 'F7 cannot log in', channel: 'email' } });
  assert.equal(raised.status, 200);
  assert.equal(raised.body.status, 'open');
  const id = raised.body.ticket_id;
  try {
    // Scope: the raiser reads their own; a different employee is refused; an agent may read.
    assert.equal((await H.req('GET', `/support/tickets/${id}`, { token: emp })).status, 200, 'raiser reads own ticket');
    assert.equal((await H.req('GET', `/support/tickets/${id}`, { token: dave })).status, 403, 'another employee cannot read it');
    assert.equal((await H.req('GET', `/support/tickets/${id}`, { token: admin })).status, 200, 'support agent may read any ticket');

    // Lifecycle: the raiser cannot transition; the support role can.
    assert.equal((await H.req('POST', `/support/tickets/${id}/transition`, { token: emp, body: { to: 'in_progress' } })).status, 403,
      'a raiser cannot drive the lifecycle');
    const moved = await H.req('POST', `/support/tickets/${id}/transition`, { token: admin, body: { to: 'in_progress' } });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.status, 'in_progress');

    // List scope: raiser sees only own; agent sees all.
    const le = await H.req('GET', '/support/tickets', { token: emp });
    assert.equal(le.body.scope, 'own');
    assert.ok(le.body.tickets.some((t) => t.id === id));
    const la = await H.req('GET', '/support/tickets', { token: admin });
    assert.equal(la.body.scope, 'all');
  } finally {
    await owner(`DELETE FROM notification WHERE kind='support.ticket' AND body->>'ticket_id'=$1`, [id]);
    await owner(`DELETE FROM support_ticket WHERE id=$1`, [id]);
  }
});

// ── Policy (POL-01..04): self-service read/ack; admin publish; reports outstanding ─
test('policy: read + ack self-service; publish is admin; outstanding is reports-only; a new version re-opens acks', async () => {
  const emp = await tok(F.USERS.EMP_A);     // R01 (employee ALICE)
  const admin = await tok(F.USERS.ADMIN_A); // R12 (admin.config.write + reports)
  const CODE = 'F7-COND';
  const activeCount = Number((await owner(
    `SELECT count(*)::int n FROM employee WHERE company_id=$1 AND status='active'`, [A])).rows[0].n);

  // POL-01 publish guard: a self-service employee cannot publish a company policy.
  assert.equal((await H.req('POST', '/policy', { token: emp, body: { code: CODE, title: 'Code of Conduct' } })).status, 403);

  const v1 = await H.req('POST', '/policy', { token: admin, body: { code: CODE, title: 'Code of Conduct' } });
  assert.equal(v1.status, 200);
  assert.equal(v1.body.version, 1);
  try {
    // POL-02 read: self-service.
    const read = await H.req('GET', `/policy/${CODE}`, { token: emp });
    assert.equal(read.status, 200);
    assert.equal(read.body.version, 1);

    // POL-04 outstanding: reports-only. Employee refused; admin sees the count.
    assert.equal((await H.req('GET', `/policy/${CODE}/outstanding`, { token: emp })).status, 403);
    const o0 = await H.req('GET', `/policy/${CODE}/outstanding`, { token: admin });
    assert.equal(o0.body.outstanding, activeCount, 'everyone outstanding at publish');

    // POL-03 ack: self-service; reduces the outstanding count.
    const ack = await H.req('POST', `/policy/${CODE}/ack`, { token: emp });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.acknowledged, true);
    assert.equal((await H.req('GET', `/policy/${CODE}/outstanding`, { token: admin })).body.outstanding, activeCount - 1);

    // A new version re-opens acknowledgement for everyone (v1 ack does not carry).
    const v2 = await H.req('POST', '/policy', { token: admin, body: { code: CODE, title: 'Code of Conduct (rev)' } });
    assert.equal(v2.body.version, 2);
    assert.equal((await H.req('GET', `/policy/${CODE}/outstanding`, { token: admin })).body.outstanding, activeCount, 'new version resets acks');
  } finally {
    await owner(`DELETE FROM policy_ack WHERE policy_code=$1`, [CODE]);
    await owner(`DELETE FROM policy WHERE code=$1`, [CODE]);
  }
});
