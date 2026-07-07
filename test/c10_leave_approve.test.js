'use strict';
// C10 — leave approve + coverage (LV-03 · LR-6 · UNI-06 · SOD-01). Pins:
//   • the queue/decide endpoints carry the leave.approve RBAC action
//     (R02/R04/R11) — a non-approver is 403;
//   • SOD-01: the requester never decides their own leave (same-user-403);
//   • a site-bound approver sees/decides only their own site's requests;
//   • LR-6 coverage is WARN-NOT-BLOCK: thresholds [TBC] → status 'pending'
//     and approval proceeds; configured + below threshold → 409 carrying the
//     meter unless the approver acknowledges the gap; the acknowledged
//     override is audited (UNI-06) and marked on the request;
//   • a decline returns the days to the balance (declined never consumes).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const leave = require('../src/leave');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const director = { company_id: A, user_id: F.USERS.DIRECTOR_A.id, role_code: 'R11' }; // central approver (employee ALICE)
const supA1 = { company_id: A, user_id: F.USERS.SUP_A.id, role_code: 'R02' };         // site-bound approver @A1 (employee ALICE)
const alice = { company_id: A, user_id: F.USERS.EMP_A.id, role_code: 'R01' };          // requester, employee ALICE
const frank = { company_id: A, user_id: F.USERS.FIELD_A.id, role_code: 'R13' };        // requester, employee FIELDA @A1

const setThresholds = (v) => owner(
  `UPDATE config SET value=$2 WHERE company_id=$1 AND key='leave.coverage.thresholds'`, [A, v]);

before(H.start);
after(async () => { await setThresholds('__TBC__'); await H.stop(); });

async function cleanup(reqIds) {
  for (const id of reqIds.filter(Boolean)) {
    await owner(`DELETE FROM notification WHERE kind='leave.decision' AND body->>'request_id'=$1`, [id]);
    await owner('DELETE FROM leave_request WHERE id=$1', [id]);
  }
}

test('C10: SOD-01, site scope, [TBC] coverage pending, decline restores balance', async () => {
  const ids = [];
  try {
    // Frank (FIELDA @A1) applies with a window; the request enters the queue.
    const req = await leave.apply(frank, { leave_type: 'annual', days: 5, from_date: '2026-08-11', to_date: '2026-08-15' });
    ids.push(req.id);
    assert.equal(req.from_date, '2026-08-11');

    // Queue: central approver sees it, WITH a coverage meter ([TBC] → pending).
    const q = await leave.queue(director);
    const mine = q.pending.find((p) => p.id === req.id);
    assert.ok(mine, 'request in the approval queue');
    assert.equal(mine.coverage.status, 'pending', 'LR-6 unconfigured → coverage pending, not a guess');

    // SOD-01: Alice's own request cannot be decided by ANY session mapping to
    // the same person — the director shares the ALICE employee record.
    const own = await leave.apply(alice, { leave_type: 'annual', days: 1 });
    ids.push(own.id);
    await assert.rejects(leave.decide(director, own.id, { approve: true }), /own leave/, 'same-user-403 (SOD-01)');
    await cleanup([own.id]);

    // Site scope: DAVE @A2's request is outside the A1 supervisor's site.
    const dave = (await owner(
      `INSERT INTO leave_request(company_id, employee_id, leave_type, days, status, from_date, to_date)
       VALUES ($1,$2,'annual',3,'applied','2026-08-11','2026-08-13') RETURNING id`, [A, F.EMP.DAVE])).rows[0];
    ids.push(dave.id);
    const qSup = await leave.queue(supA1);
    assert.ok(!qSup.pending.some((p) => p.id === dave.id), 'site-bound queue excludes other sites');
    assert.ok(qSup.pending.some((p) => p.id === req.id), 'site-bound queue includes own site');
    await assert.rejects(leave.decide(supA1, dave.id, { approve: true }), /outside your site/);

    // [TBC] thresholds: approval proceeds WITHOUT an override (nothing to warn on).
    const ok = await leave.decide(supA1, req.id, { approve: true });
    assert.equal(ok.status, 'approved');
    assert.equal(ok.coverage_override, false);
    assert.equal(ok.coverage.status, 'pending');
    await assert.rejects(leave.decide(supA1, req.id, { approve: false }), /already approved/);

    // Decline returns the days: balance before == balance after apply+decline.
    const before0 = (await leave.balance(frank)).annual.available;
    const req2 = await leave.apply(frank, { leave_type: 'annual', days: 4 });
    ids.push(req2.id);
    const dec = await leave.decide(director, req2.id, { approve: false, note: 'coverage planning' });
    assert.equal(dec.status, 'declined');
    assert.equal((await leave.balance(frank)).annual.available, before0, 'declined leave never consumes balance');

    // The requester is notified in ESS on each decision.
    const notif = (await owner(
      `SELECT count(*)::int n FROM notification WHERE kind='leave.decision' AND employee_id=$1`, [F.EMP.FIELDA])).rows[0].n;
    assert.ok(notif >= 2, 'requester notified of approve + decline');
  } finally {
    await cleanup(ids);
  }
});

test('C10: LR-6 warn-not-block — 409 with the meter, audited override approves (UNI-06)', async () => {
  // A dedicated site with exactly two active R01s gives a deterministic meter —
  // the seeded bulk directory never touches this site.
  const site = (await owner(
    `INSERT INTO site(company_id, name) VALUES ($1,'Coverage Test Site') RETURNING id`, [A])).rows[0].id;
  const mkEmp = async (no, name) => (await owner(
    `INSERT INTO employee(company_id, site_id, emp_no, full_name, role_code, dept, status)
     VALUES ($1,$2,$3,$4,'R01','Ops','active') RETURNING id`, [A, site, no, name])).rows[0].id;
  const cv1 = await mkEmp('TMCL-CV-0001', 'Cova One');
  const cv2 = await mkEmp('TMCL-CV-0002', 'Cova Two');
  const reqId = (await owner(
    `INSERT INTO leave_request(company_id, employee_id, leave_type, days, status, from_date, to_date)
     VALUES ($1,$2,'annual',7,'applied','2026-08-11','2026-08-19') RETURNING id`, [A, cv1])).rows[0].id;
  try {
    // Threshold 2 R01s present, but approving CV1 leaves only CV2 → warn.
    await setThresholds('R01:2');
    const q = await leave.queue(director);
    const meter = q.pending.find((p) => p.id === reqId).coverage;
    assert.deepEqual(
      { status: meter.status, present: meter.present, threshold: meter.threshold },
      { status: 'warn', present: 1, threshold: 2 }, 'the meter shows the gap');

    // Warn-not-block leg 1: no acknowledgement → 409 CARRYING the meter.
    await assert.rejects(leave.decide(director, reqId, { approve: true }), (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.body.coverage.status, 'warn');
      assert.equal(e.body.coverage.present, 1);
      return true;
    });

    // Warn-not-block leg 2: acknowledged override → approved + audited (UNI-06).
    const ok = await leave.decide(director, reqId, { approve: true, override_ack: true, note: 'contractor covers' });
    assert.equal(ok.status, 'approved');
    assert.equal(ok.coverage_override, true);
    const row = (await owner('SELECT coverage_override, decided_by FROM leave_request WHERE id=$1', [reqId])).rows[0];
    assert.equal(row.coverage_override, true);
    assert.equal(row.decided_by, F.USERS.DIRECTOR_A.id);
    const aud = (await owner(
      `SELECT actor, role FROM audit WHERE company_id=$1 AND action='leave.coverage.override' AND entity_id=$2`,
      [A, reqId])).rows;
    assert.equal(aud.length, 1, 'the override is a first-class audit event');
    assert.equal(aud[0].role, 'R11');

    // With CV1 now on approved leave, CV2's overlapping request drops present
    // to 0 — the meter reflects approved overlaps.
    const req2 = (await owner(
      `INSERT INTO leave_request(company_id, employee_id, leave_type, days, status, from_date, to_date)
       VALUES ($1,$2,'annual',3,'applied','2026-08-12','2026-08-14') RETURNING id`, [A, cv2])).rows[0].id;
    const meter2 = (await leave.queue(director)).pending.find((p) => p.id === req2).coverage;
    assert.deepEqual({ status: meter2.status, present: meter2.present }, { status: 'warn', present: 0 });
    await owner('DELETE FROM leave_request WHERE id=$1', [req2]);

    // Raising the bar back down: threshold 1 with CV2 present → ok, no override.
    await setThresholds('R01:1');
    const req3 = (await owner(
      `INSERT INTO leave_request(company_id, employee_id, leave_type, days, status, from_date, to_date)
       VALUES ($1,$2,'annual',2,'applied','2027-01-05','2027-01-06') RETURNING id`, [A, cv2])).rows[0].id;
    const ok3 = await leave.decide(director, req3, { approve: true });
    assert.equal(ok3.status, 'approved');
    assert.equal(ok3.coverage.status, 'ok');
    assert.equal(ok3.coverage_override, false);
    await owner('DELETE FROM leave_request WHERE id=$1', [req3]);
  } finally {
    await setThresholds('__TBC__');
    await owner(`DELETE FROM notification WHERE kind='leave.decision' AND employee_id IN ($1,$2)`, [cv1, cv2]);
    await owner('DELETE FROM leave_request WHERE employee_id IN ($1,$2)', [cv1, cv2]);
    await owner('DELETE FROM employee WHERE id IN ($1,$2)', [cv1, cv2]);
    await owner('DELETE FROM site WHERE id=$1', [site]);
  }
});

test('C10 endpoints: RBAC leave.approve at the HTTP layer', async () => {
  const tok = async (u) => (await H.loginConsole(u)).body.token;
  const empTok = await tok(F.USERS.EMP_A);       // R01 — not an approver
  const supTok = await tok(F.USERS.SUP_A);       // R02 — approver
  assert.equal((await H.req('GET', '/leave/requests')).status, 401);
  assert.equal((await H.req('GET', '/leave/requests', { token: empTok })).status, 403);
  const q = await H.req('GET', '/leave/requests', { token: supTok });
  assert.equal(q.status, 200);
  assert.ok(Array.isArray(q.body.pending));
  assert.equal((await H.req('POST', '/leave/requests/00000000-0000-0000-0000-000000000000/decide',
    { token: empTok, body: { approve: true } })).status, 403);
  assert.equal((await H.req('POST', '/leave/requests/00000000-0000-0000-0000-000000000000/decide',
    { token: supTok, body: { approve: true } })).status, 404);
});
