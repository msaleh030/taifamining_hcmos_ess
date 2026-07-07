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
    `INSERT INTO employee_document(company_id,employee_id,kind,name,valid_until,permit_type)
     VALUES ($1,$2,'permit','Confined space',$3,'business') RETURNING id`,
    [A, F.EMP.CAROL, '2026-07-29'])).rows[0].id; // within the 60-day permit lead at asOf
  try {
    const r1 = await docalerts.runExpiryAlerts(admin, '2026-06-29');
    const raised = r1.raised.find((x) => x.document_id === docId);
    assert.ok(raised, 'alert raised for the expiring permit');
    assert.equal(raised.notify_role, 'R06', 'business permit routed to the SHEQ Manager (registry)');

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

// ── 2b. Each document type routes to its DA-2 leg (three-way split, Kira
//        2026-07-06): expat permit→R11 only; business permit/licence→R06;
//        medical→site-matched R03; unclassified permit fails CLOSED to R11. ──
test('expiry alerts route each document type to its registry DA-2 leg', async () => {
  // valid_until 2026-07-10 is within every DA-1 lead window at this asOf.
  // Contract splits expat-vs-local (Kira, 2026-07-06): DAVE is flagged expat
  // for the test; CAROL stays local (default false).
  const cases = [
    { name: 'contract-local', kind: 'contract', permitType: null, role: 'R03', site: F.SITE.A1 },          // Carol's site
    { name: 'contract-expat', kind: 'contract', permitType: null, role: 'R11', emp: F.EMP.DAVE },          // sensitive — Head of HR ONLY
    { name: 'permit-expat', kind: 'permit', permitType: 'expat', role: 'R11' },      // sensitive — Head of HR ONLY
    { name: 'permit-business', kind: 'permit', permitType: 'business', role: 'R06' },
    { name: 'permit-unclassified', kind: 'permit', permitType: null, role: 'R11', unclassified: true }, // fail closed, never guessed
    { name: 'licence', kind: 'licence', permitType: null, role: 'R06' },
    { name: 'medical', kind: 'medical', permitType: null, role: 'R03', site: F.SITE.A1 }, // Carol's site
  ];
  const ids = {};
  await owner(`UPDATE employee SET is_expat=true WHERE id=$1`, [F.EMP.DAVE]);
  for (const t of cases) {
    ids[t.name] = (await owner(
      `INSERT INTO employee_document(company_id,employee_id,kind,name,valid_until,permit_type)
       VALUES ($1,$2,$3,$4,'2026-07-10',$5) RETURNING id`,
      [A, t.emp || F.EMP.CAROL, t.kind, `T-${t.name}`, t.permitType])).rows[0].id;
  }
  try {
    const r = await docalerts.runExpiryAlerts(admin, '2026-06-29');
    for (const t of cases) {
      const raised = r.raised.find((x) => x.document_id === ids[t.name]);
      assert.ok(raised, `${t.name} raised an alert`);
      assert.equal(raised.notify_role, t.role, `${t.name} → ${t.role} (registry DA-2 leg)`);
      assert.equal(raised.unclassified, !!t.unclassified, `${t.name} unclassified flag`);
      if (t.site) assert.equal(raised.notify_site, t.site, `${t.name} carries the employee's site (site-matched R03)`);
      const notif = (await owner(
        `SELECT recipient, body FROM notification WHERE kind='doc.expiry' AND body->>'document_id'=$1`, [ids[t.name]])).rows;
      assert.ok(notif.some((n) => n.recipient === t.role), `${t.name} notification recipient ${t.role}`);
      if (t.site) assert.ok(notif.some((n) => n.body.site_id === t.site), `${t.name} notification carries site for the E2 reader`);
    }
    assert.equal(r.unclassified_count, 1, 'exactly the unclassified permit is flagged for Kira to classify');
  } finally {
    await owner(`UPDATE employee SET is_expat=false WHERE id=$1`, [F.EMP.DAVE]);
    for (const id of Object.values(ids)) {
      await owner(`DELETE FROM notification WHERE kind='doc.expiry' AND body->>'document_id'=$1`, [id]);
      await owner(`DELETE FROM employee_document WHERE id=$1`, [id]);
    }
  }
});

// ── 2c. Dashboard visibility follows the DA-2 legs (row-level, on top of the
//        alerts.view.roles gate): expat + unclassified permits are R11-ONLY
//        (the admin does NOT see them); medical only for the R03 whose site
//        matches the employee's; business permits unchanged (all members). ──
test('alert dashboard visibility: expat R11-only; medical site-matched R03; business unchanged', async () => {
  const hoh = { company_id: A, user_id: F.USERS.DIRECTOR_A.id, role_code: 'R11' };
  const hrA1 = { company_id: A, user_id: F.USERS.HR_A.id, role_code: 'R03' };      // employee at SITE.A1
  const mk = async (emp, kind, permitType) => (await owner(
    `INSERT INTO employee_document(company_id,employee_id,kind,name,valid_until,permit_type)
     VALUES ($1,$2,$3,$4,'2026-07-10',$5) RETURNING id`, [A, emp, kind, `V-${kind}-${permitType || 'none'}-${emp.slice(-2)}`, permitType])).rows[0].id;
  await owner(`UPDATE employee SET is_expat=true WHERE id=$1`, [F.EMP.DSUBJ]); // Dan @A1 — expat for the contract leg
  const ids = {
    expat: await mk(F.EMP.CAROL, 'permit', 'expat'),
    unclassified: await mk(F.EMP.CAROL, 'permit', null),
    business: await mk(F.EMP.CAROL, 'permit', 'business'),
    medicalA1: await mk(F.EMP.CAROL, 'medical', null), // Carol @ SITE.A1 — HR_A's site
    medicalA2: await mk(F.EMP.DAVE, 'medical', null),  // Dave @ SITE.A2 — NOT HR_A's site
    contractExpat: await mk(F.EMP.DSUBJ, 'contract', null), // expat contract — R11 only
    contractLocal: await mk(F.EMP.CAROL, 'contract', null), // local contract — site R03 only
  };
  try {
    await docalerts.runExpiryAlerts(admin, '2026-06-29');
    const seen = async (s) => new Set((await docalerts.listOpen(s)).open.map((a) => a.document_id));

    const r11 = await seen(hoh);
    assert.ok(r11.has(ids.expat) && r11.has(ids.unclassified), 'R11 sees the sensitive permit legs');
    assert.ok(r11.has(ids.business), 'R11 sees business permits (unchanged leg)');
    assert.ok(!r11.has(ids.medicalA1) && !r11.has(ids.medicalA2), 'medical is site-R03 only — not the Head of HR');
    assert.ok(r11.has(ids.contractExpat), 'R11 sees the expat contract (sensitive leg)');
    assert.ok(!r11.has(ids.contractLocal), 'local contracts are site-R03 only — not the Head of HR');

    const r12 = await seen(admin);
    assert.ok(!r12.has(ids.expat) && !r12.has(ids.unclassified), 'expat/unclassified permits are R11-ONLY — hidden from the admin');
    assert.ok(r12.has(ids.business), 'admin still sees business permits (unchanged leg)');
    assert.ok(!r12.has(ids.medicalA1), 'admin does not see medical (site-R03 only)');
    assert.ok(!r12.has(ids.contractExpat) && !r12.has(ids.contractLocal), 'contract legs hidden from the admin');

    const r03 = await seen(hrA1);
    assert.ok(r03.has(ids.medicalA1), 'the R03 at the employee\'s site sees the medical alert');
    assert.ok(!r03.has(ids.medicalA2), 'an R03 at ANOTHER site does not — site-matched, not all HR Officers');
    assert.ok(!r03.has(ids.expat) && !r03.has(ids.unclassified), 'R03 never sees the sensitive permit legs');
    assert.ok(r03.has(ids.contractLocal), 'the R03 at the employee\'s site sees the local contract');
    assert.ok(!r03.has(ids.contractExpat), 'the expat contract never reaches an R03');
  } finally {
    await owner(`UPDATE employee SET is_expat=false WHERE id=$1`, [F.EMP.DSUBJ]);
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
  const diss = { company_id: A, user_id: F.USERS.DISS_A.id, role_code: 'R06' };  // employee DISS (active; R05 absorbed, v1.6)
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
