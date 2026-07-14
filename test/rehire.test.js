'use strict';
// REHIRE ruling (Kira 2026-07-14, MOV-02). Pins:
//   1. SAME TMCL — the original row reactivates; the number is recovered
//      verbatim, never re-minted;
//   2. THE CHOICE IS FORCED — no continuity (or an unknown one), or a missing
//      reason, refuses 400. No silent default, ever;
//   3. bridge keeps the service anchor (joined_at unchanged); reset moves it
//      to the rehire date — the leave-accrual anchor follows the decision;
//   4. R11 ONLY — any other role is refused 403;
//   5. the decision is AUDITED (actor, role, before/after) and recorded on
//      employee_rehire with the reason;
//   6. rehiring an ACTIVE person is a 409, not a silent no-op.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;
const ids = {};

before(async () => {
  await H.start();
  ids.emp = (await owner(
    `INSERT INTO employee(id,company_id,site_id,full_name,emp_no,role_code,status,is_expat,joined_at)
     VALUES (gen_random_uuid(),$1,$2,'Zz Rehire Case','TMCL-NM-8801','R13','terminated',false,'2023-05-10') RETURNING id`,
    [A, F.SITE.A1])).rows[0].id;
});
after(async () => {
  await owner(`DELETE FROM employee_rehire WHERE employee_id=$1`, [ids.emp]);
  await owner(`DELETE FROM employee WHERE id=$1`, [ids.emp]);
  await H.stop();
});

const rehire = (token, id, body) => H.req('POST', `/employees/${id}/rehire`, { token, body });

test('RH-1 the choice is FORCED: no continuity → 400; unknown → 400; no reason → 400', async () => {
  const r11 = await tok(F.USERS.DIRECTOR_A);
  const none = await rehire(r11, ids.emp, { reason: 'came back' });
  assert.equal(none.status, 400, JSON.stringify(none.body));
  assert.match(none.body.error, /bridge or reset/, 'the refusal names the required choice');
  assert.match(none.body.error, /no default/, 'and says there is no default');
  assert.equal((await rehire(r11, ids.emp, { continuity: 'maybe', reason: 'x' })).status, 400);
  const noReason = await rehire(r11, ids.emp, { continuity: 'bridge' });
  assert.equal(noReason.status, 400);
  assert.match(noReason.body.error, /reason/, 'the reason is not optional');
});

test('RH-2 R11 only — an R03 HR Officer is refused', async () => {
  const r03 = await tok(F.USERS.HR_A);
  const r = await rehire(r03, ids.emp, { continuity: 'bridge', reason: 'x' });
  assert.equal(r.status, 403, JSON.stringify(r.body));
});

test('RH-3 BRIDGE: same TMCL recovered, service anchor UNCHANGED, recorded + audited', async () => {
  const r11 = await tok(F.USERS.DIRECTOR_A);
  const r = await rehire(r11, ids.emp, { continuity: 'bridge', reason: 'Left on project completion; TZ continuity applies per Omid ruling.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.emp_no, 'TMCL-NM-8801', 'the ORIGINAL number is recovered — never re-minted');
  assert.equal(r.body.continuity, 'bridge');
  assert.equal(r.body.service_anchor, '2023-05-10', 'bridge keeps the anchor');
  const row = (await owner(`SELECT status, emp_no, joined_at::text AS j FROM employee WHERE id=$1`, [ids.emp])).rows[0];
  assert.equal(row.status, 'active');
  assert.equal(row.emp_no, 'TMCL-NM-8801');
  assert.equal(row.j, '2023-05-10');
  const rec = (await owner(`SELECT continuity, reason, decided_by FROM employee_rehire WHERE employee_id=$1`, [ids.emp])).rows[0];
  assert.equal(rec.continuity, 'bridge');
  assert.match(rec.reason, /Omid/);
  assert.equal(rec.decided_by, F.USERS.DIRECTOR_A.id, 'the decision is the R11\'s, on the record');
  const audit = (await owner(
    `SELECT actor, role, before, after FROM audit WHERE company_id=$1 AND action='employee.rehire' AND entity_id=$2 ORDER BY seq DESC LIMIT 1`,
    [A, ids.emp])).rows[0];
  assert.ok(audit, 'audited');
  assert.equal(audit.role, 'R11');
  assert.equal(audit.after.continuity, 'bridge');
  assert.ok(audit.after.reason, 'the reason rides the audit entry');
});

test('RH-4 rehiring an ACTIVE person is a 409; RESET moves the anchor to the rehire date', async () => {
  const r11 = await tok(F.USERS.DIRECTOR_A);
  const again = await rehire(r11, ids.emp, { continuity: 'reset', reason: 'x' });
  assert.equal(again.status, 409, 'already active — nothing to rehire');
  await owner(`UPDATE employee SET status='terminated' WHERE id=$1`, [ids.emp]);
  const r = await rehire(r11, ids.emp, { continuity: 'reset', reason: 'Resigned and re-applied; service resets per policy.', rehire_date: '2026-07-01' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.service_anchor, '2026-07-01', 'reset anchors service at the rehire date');
  const row = (await owner(`SELECT joined_at::text AS j FROM employee WHERE id=$1`, [ids.emp])).rows[0];
  assert.equal(row.j, '2026-07-01', 'leave accrual and service math now anchor here');
});
