'use strict';
// Slice 4 — Disciplinary action + fan-out (C8). AC-DISC-01..04, AC-SOD-01/02,
// AC-UNI-06, plus the four Section-17 tests: atomicity, audit-chain integrity,
// SoD (server-enforced even on a direct call), suspension-blocks-login.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const disc = require('../src/disciplinary');
const { F } = H;

const A = F.TENANT_A;
// Acting sessions (server trusts these; the request body never sets identity).
const issuer   = { company_id: A, user_id: F.USERS.DISS_A.id, role_code: 'R06' }; // Ivy, permitted issuer (R05 absorbed, v1.6)
const approver = F.USERS.DCHK_A.id;                                              // Cate, permitted checker
const SUBJECT  = F.EMP.DSUBJ;

const owner = (sql, params) => db.withOwner((c) => c.query(sql, params));
const count = async (table, empId) =>
  Number((await owner(`SELECT count(*)::int n FROM ${table} WHERE employee_id=$1`, [empId])).rows[0].n);

// Row-level audit verifier: recompute the stored hash from the row's own fields.
const RECOMPUTE = `SELECT (hash = encode(sha256(convert_to(prev_hash || concat_ws('|',
    company_id::text, coalesce(actor,''), coalesce(role,''), action,
    coalesce(entity,''), coalesce(entity_id,''), ts::text,
    coalesce(before::text,''), coalesce(after::text,'')), 'UTF8')),'hex')) AS ok
  FROM audit WHERE seq=$1`;

before(H.start);
after(H.stop);

// ── AC-DISC-01/02 + AC-UNI-06: confirmed action fans out as one linked event ─
test('AC-DISC-01/02 confirmed action fans out (register, notifications, letter, feed, audit); manager resolved', async () => {
  const res = await disc.issueAction(issuer, { employeeId: SUBJECT, actionType: 'written', detail: 'unsafe act', approverUserId: approver });
  assert.equal(res.ok, true);
  assert.equal(res.manager, 'Alice Admin', 'line manager resolved from the subject’s site (A1)');

  // 1. register entry with issuer/approver/manager captured
  const reg = (await owner(`SELECT * FROM disciplinary WHERE id=$1`, [res.id])).rows[0];
  assert.equal(reg.action_type, 'written');
  assert.equal(reg.issued_by, 'ivy@a.example');
  assert.equal(reg.issuer_role, 'R06');
  assert.equal(reg.approver, 'cate@a.example');
  assert.equal(reg.approver_role, 'R04');
  assert.equal(reg.manager_name, 'Alice Admin');

  // 2/3. ESS + console notifications; console names the line manager + HR
  const notifs = (await owner(
    `SELECT audience, body FROM notification WHERE employee_id=$1 ORDER BY audience`, [SUBJECT])).rows;
  assert.deepEqual(notifs.map((n) => n.audience), ['console', 'ess']);
  const console_ = notifs.find((n) => n.audience === 'console');
  assert.equal(console_.body.line_manager, 'Alice Admin');
  assert.equal(console_.body.hr_role, 'R04');

  // 4. auto warning letter in My Documents
  const docs = (await owner(
    `SELECT kind, name FROM employee_document WHERE employee_id=$1 AND kind='warning'`, [SUBJECT])).rows;
  assert.equal(docs.length, 1);
  assert.match(docs[0].name, /Warning letter/);

  // 5. activity-feed entry
  const feed = (await owner(
    `SELECT count(*)::int n FROM activity_feed WHERE employee_id=$1 AND kind='disciplinary.action'`, [SUBJECT])).rows[0];
  assert.equal(feed.n, 1);

  // 6. audit shows the fan-out as one linked event
  const aud = (await owner(
    `SELECT action, after FROM audit WHERE entity='disciplinary' AND entity_id=$1`, [res.id])).rows;
  assert.equal(aud.length, 1);
  assert.equal(aud[0].action, 'disciplinary.action.issue');
  assert.equal(aud[0].after.manager, 'Alice Admin');
});

// ── Section 17.1: atomicity — a mid-fan-out failure commits NOTHING ─────────
test('S17.1 atomicity: a mid-fan-out failure leaves no partial register entry or orphan notification', async () => {
  const dBefore = await count('disciplinary', SUBJECT);
  const nBefore = await count('notification', SUBJECT);

  await assert.rejects(
    disc.issueAction(issuer, { employeeId: SUBJECT, actionType: 'written', detail: 'boom', approverUserId: approver },
      { faultStep: 'after_ess' }), /injected fault/);

  assert.equal(await count('disciplinary', SUBJECT), dBefore, 'no partial register entry');
  assert.equal(await count('notification', SUBJECT), nBefore, 'no orphan notification');
});

// ── Section 17.2: audit-chain integrity — tamper is detected at that link ────
test('S17.2 audit-chain integrity: mutating the new audit row makes the verifier fail at that link', async () => {
  const res = await disc.issueAction(issuer, { employeeId: SUBJECT, actionType: 'verbal', detail: 'late', approverUserId: approver });

  const result = await db.withOwner(async (c) => {
    const row = (await c.query(
      `SELECT seq, after::text AS after_text FROM audit
        WHERE entity='disciplinary' AND entity_id=$1 AND action='disciplinary.action.issue'`, [res.id])).rows[0];
    try {
      await c.query('ALTER TABLE audit DISABLE TRIGGER audit_no_mutate'); // simulate storage-layer tamper
      await c.query(`UPDATE audit SET after='{"tampered":true}'::jsonb WHERE seq=$1`, [row.seq]);
      const bad = (await c.query(RECOMPUTE, [row.seq])).rows[0].ok;
      await c.query('UPDATE audit SET after=$1::jsonb WHERE seq=$2', [row.after_text, row.seq]); // restore
      const good = (await c.query(RECOMPUTE, [row.seq])).rows[0].ok;
      return { bad, good };
    } finally {
      await c.query('ALTER TABLE audit ENABLE TRIGGER audit_no_mutate');
    }
  });

  assert.equal(result.bad, false, 'verifier fails at the tampered link');
  assert.equal(result.good, true, 'row restored — chain verifies again');
});

// ── Section 17.3 + AC-SOD-01/02: SoD server-enforced on every forbidden combo ─
test('S17.3 SoD: every forbidden issuer/subject/approver combo is refused on a direct call', async () => {
  // issuer role not permitted
  await assert.rejects(disc.issueAction(
    { company_id: A, user_id: F.USERS.EMP_A.id, role_code: 'R01' },
    { employeeId: SUBJECT, actionType: 'written', approverUserId: approver }), /issuer not permitted/);

  // subject == issuer (cannot act on self)
  await assert.rejects(disc.issueAction(issuer,
    { employeeId: F.EMP.DISS, actionType: 'written', approverUserId: approver }), /cannot act on self/);

  // approver not permitted (R01)
  await assert.rejects(disc.issueAction(issuer,
    { employeeId: SUBJECT, actionType: 'written', approverUserId: F.USERS.DSUBJ_A.id }), /approver not permitted/);

  // approver == subject
  await assert.rejects(disc.issueAction(issuer,
    { employeeId: F.EMP.DCHK, actionType: 'written', approverUserId: F.USERS.DCHK_A.id }), /approver cannot be the subject/);

  // sanity: the permitted, distinct combination is accepted
  const ok = await disc.issueAction(issuer, { employeeId: SUBJECT, actionType: 'written', approverUserId: approver });
  assert.equal(ok.ok, true);
});

// ── Section 17.4 + AC-DISC-03: suspension flips status and blocks login app-wide ─
test('S17.4 suspension flips lifecycle status and the block takes effect app-wide', async () => {
  // The subject can sign in beforehand.
  const before = await H.loginConsole(F.USERS.DSUBJ_A);
  assert.equal(before.status, 200);
  assert.ok(before.body.token);

  const res = await disc.issueAction(issuer, { employeeId: SUBJECT, actionType: 'suspension', detail: 'gross misconduct', approverUserId: approver });
  assert.equal(res.suspended, true);

  const emp = (await owner(`SELECT status FROM employee WHERE id=$1`, [SUBJECT])).rows[0];
  assert.equal(emp.status, 'suspended', 'lifecycle enum flipped');
  const usr = (await owner(`SELECT status FROM app_user WHERE id=$1`, [F.USERS.DSUBJ_A.id])).rows[0];
  assert.equal(usr.status, 'suspended', 'login state flipped app-wide');
  const aud = (await owner(
    `SELECT count(*)::int n FROM audit WHERE action='employee.status.suspend' AND entity_id=$1`, [SUBJECT])).rows[0];
  assert.equal(aud.n, 1, 'status change audited');

  // The block takes effect: the same credentials are now refused.
  const afterLogin = await H.loginConsole(F.USERS.DSUBJ_A);
  assert.equal(afterLogin.status, 401);
  assert.ok(!afterLogin.body.token);
});
