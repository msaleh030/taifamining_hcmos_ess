'use strict';
// Slice 9 — Controls & Checker, expiry alerts, support tickets, policy ack.
// Wired onto the existing SoD/maker-checker, audit-chain and DA-1 lead-time
// engines. Runs last (fixtures are seeded per-test and cleaned up).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const controls = require('../src/controls');
const docalerts = require('../src/docalerts');
const support = require('../src/support');
const policy = require('../src/policy');
const { F } = H;

const A = F.TENANT_A;
const admin = { company_id: A, user_id: F.USERS.ADMIN_A.id, role_code: 'R12' };
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));

before(H.start);
after(H.stop);

// ── 1. Controls & Checker (C20, AC-AUD-03): flag offenders per check ────────
test('controls flags SoD breach / leaver-with-access / GPS-less punch and lists the offending rows', async () => {
  const seeded = {};
  seeded.fc = (await owner(
    `INSERT INTO field_change(company_id,employee_id,field,before,after,maker,maker_role,status,checker,decided_at)
     VALUES ($1,$2,'phone','1','2','self@a.example','R03','approved','self@a.example',now()) RETURNING id`,
    [A, F.EMP.CAROL])).rows[0].id;
  seeded.att = (await owner(
    `INSERT INTO attendance(company_id,employee_id,source) VALUES ($1,$2,'field') RETURNING id`,
    [A, F.EMP.CAROL])).rows[0].id;
  await owner(`UPDATE app_user SET status='active' WHERE id=$1`, [F.USERS.TERM_A.id]); // leaver regains access
  try {
    const { checks } = await controls.runControls(admin);
    const by = Object.fromEntries(checks.map((c) => [c.check, c]));

    assert.equal(by['sod.self_approval'].pass, false);
    assert.ok(by['sod.self_approval'].offenders.some((o) => o.id === seeded.fc), 'lists the self-approved change');

    assert.equal(by['attendance.no_location'].pass, false);
    assert.ok(by['attendance.no_location'].offenders.some((o) => o.id === seeded.att), 'lists the GPS-less punch');

    assert.equal(by['access.leaver_retained'].pass, false);
    assert.ok(by['access.leaver_retained'].offenders.some((o) => o.email === 'term@a.example'), 'lists the leaver');

    assert.equal(by['audit.chain_integrity'].pass, true, 'audit chain intact');
    assert.deepEqual(by['audit.chain_integrity'].offenders, []);
  } finally {
    await owner(`UPDATE app_user SET status='terminated' WHERE id=$1`, [F.USERS.TERM_A.id]);
    await owner(`DELETE FROM field_change WHERE id=$1`, [seeded.fc]);
    await owner(`DELETE FROM attendance WHERE id=$1`, [seeded.att]);
  }
});

// ── 2. Expiry alerts (DA-1/DA-2): raise to the correct role; clear on renewal ─
test('an expiring document raises an alert to the DA-2 role and clears on renewal', async () => {
  const docId = (await owner(
    `INSERT INTO employee_document(company_id,employee_id,kind,name,valid_until)
     VALUES ($1,$2,'permit','Confined space',$3) RETURNING id`,
    [A, F.EMP.CAROL, '2026-07-29'])).rows[0].id; // within the 60-day permit lead at asOf
  try {
    const r1 = await docalerts.runExpiryAlerts(admin, '2026-06-29');
    const raised = r1.raised.find((x) => x.document_id === docId);
    assert.ok(raised, 'alert raised for the expiring permit');
    assert.equal(raised.notify_role, 'R06', 'routed to the DA-2 permit role from the registry');

    const alert = (await owner(`SELECT status, notify_count FROM doc_alert WHERE document_id=$1`, [docId])).rows[0];
    assert.equal(alert.status, 'open');
    const notif = (await owner(
      `SELECT recipient FROM notification WHERE kind='doc.expiry' AND body->>'document_id'=$1`, [docId])).rows;
    assert.ok(notif.some((n) => n.recipient === 'R06'), 'notified the DA-2 role');

    // Renew the document → next sweep clears the alert.
    await owner(`UPDATE employee_document SET valid_until='2027-12-31' WHERE id=$1`, [docId]);
    const r2 = await docalerts.runExpiryAlerts(admin, '2026-06-29');
    assert.ok(r2.cleared.some((x) => x.document_id === docId), 'alert cleared on renewal');
    const alert2 = (await owner(`SELECT status FROM doc_alert WHERE document_id=$1`, [docId])).rows[0];
    assert.equal(alert2.status, 'cleared');
  } finally {
    await owner(`DELETE FROM notification WHERE kind='doc.expiry' AND body->>'document_id'=$1`, [docId]);
    await owner(`DELETE FROM employee_document WHERE id=$1`, [docId]); // cascades doc_alert
  }
});

// ── 2b. Each document type routes to its APPLIED DA-2 registry role ──────────
test('expiry alerts route each document type to its registry DA-2 role', async () => {
  // valid_until 2026-07-10 is within every DA-1 lead window at this asOf.
  const expected = { contract: 'R05', permit: 'R06', licence: 'R06', medical: 'R03' };
  const ids = {};
  for (const kind of Object.keys(expected)) {
    ids[kind] = (await owner(
      `INSERT INTO employee_document(company_id,employee_id,kind,name,valid_until)
       VALUES ($1,$2,$3,$4,'2026-07-10') RETURNING id`, [A, F.EMP.CAROL, kind, `T-${kind}`])).rows[0].id;
  }
  try {
    const r = await docalerts.runExpiryAlerts(admin, '2026-06-29');
    for (const [kind, role] of Object.entries(expected)) {
      const raised = r.raised.find((x) => x.document_id === ids[kind]);
      assert.ok(raised, `${kind} raised an alert`);
      assert.equal(raised.notify_role, role, `${kind} → ${role} (registry DA-2 role)`);
    }
  } finally {
    for (const id of Object.values(ids)) {
      await owner(`DELETE FROM notification WHERE kind='doc.expiry' AND body->>'document_id'=$1`, [id]);
      await owner(`DELETE FROM employee_document WHERE id=$1`, [id]);
    }
  }
});

// ── 3. Support tickets (E12): full lifecycle with notifications ──────────────
test('a support ticket walks its full lifecycle with a notification on each change', async () => {
  const raiser = { company_id: A, user_id: F.USERS.EMP_A.id, role_code: 'R01' };
  await assert.rejects(support.raiseTicket(raiser, { subject: 'x', channel: 'sms' }), /channel not allowed/);

  const t = await support.raiseTicket(raiser, { subject: 'Cannot log in', channel: 'email' });
  assert.equal(t.status, 'open');
  for (const to of ['in_progress', 'resolved', 'closed']) {
    const r = await support.transition(raiser, t.ticket_id, to);
    assert.equal(r.status, to);
  }
  await assert.rejects(support.transition(raiser, t.ticket_id, 'open'), /illegal transition/); // closed is terminal

  const notifs = (await owner(
    `SELECT count(*)::int n FROM notification WHERE kind='support.ticket' AND body->>'ticket_id'=$1`, [t.ticket_id]));
  assert.equal(notifs.rows[0].n, 4, 'open + in_progress + resolved + closed');

  await owner(`DELETE FROM notification WHERE kind='support.ticket' AND body->>'ticket_id'=$1`, [t.ticket_id]);
  await owner(`DELETE FROM support_ticket WHERE id=$1`, [t.ticket_id]);
});

// ── 4. Policy acknowledgement (E7): new version resets acks; outstanding correct ─
test('a new policy version resets acknowledgement and the outstanding list is correct', async () => {
  const CODE = 'COND-SLICE9';
  const activeCount = Number((await owner(
    `SELECT count(*)::int n FROM employee WHERE company_id=$1 AND status='active'`, [A])).rows[0].n);
  const diss = { company_id: A, user_id: F.USERS.DISS_A.id, role_code: 'R05' };  // employee DISS (active)
  const dchk = { company_id: A, user_id: F.USERS.DCHK_A.id, role_code: 'R04' };  // employee DCHK (active)
  try {
    const v1 = await policy.publishPolicy(admin, { code: CODE, title: 'Code of Conduct' });
    assert.equal(v1.version, 1);
    assert.equal((await policy.outstanding(admin, CODE)).outstanding, activeCount, 'all active staff outstanding at publish');

    await policy.acknowledge(diss, CODE);
    await policy.acknowledge(dchk, CODE);
    assert.equal((await policy.outstanding(admin, CODE)).outstanding, activeCount - 2, 'two acks reduce the outstanding count');
    assert.equal(await policy.isOutstanding(diss, CODE, F.EMP.DISS), false);

    const v2 = await policy.publishPolicy(admin, { code: CODE, title: 'Code of Conduct (rev)' });
    assert.equal(v2.version, 2);
    assert.equal((await policy.outstanding(admin, CODE)).outstanding, activeCount, 'new version re-opens acknowledgement for everyone');
    assert.equal(await policy.isOutstanding(diss, CODE, F.EMP.DISS), true, 'v1 ack does not carry to v2');

    await policy.acknowledge(diss, CODE);
    assert.equal((await policy.outstanding(admin, CODE)).outstanding, activeCount - 1);
    assert.equal(await policy.isOutstanding(dchk, CODE, F.EMP.DCHK), true, 'DCHK still outstanding on v2');
  } finally {
    await owner(`DELETE FROM policy_ack WHERE policy_code=$1`, [CODE]);
    await owner(`DELETE FROM policy WHERE code=$1`, [CODE]);
  }
});
