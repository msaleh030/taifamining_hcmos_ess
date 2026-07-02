'use strict';
// Registry v1.5 role-model change (LI-2/LI-4/LI-5) — both halves are
// CONFIDENTIALITY-BOUNDARY changes, so each new visibility (and each deliberate
// absence) is pinned here, at the unit level AND through the real HTTP profile.
//
//   LI-2: R10 (Clinic/Medical Staff) removed; HR Officer (R03) absorbs
//         clinic/medical administration (modules + medical/permit A3 fields).
//   LI-5 (OPEN, held for Kira): R03 now SEES medical records — pinned so the
//         widening is explicit, ratified only when Kira confirms.
//   LI-4 (OPEN, held for Kira): the new CEO/Executive (R14) is read-only,
//         org-wide, and does NOT see individual pay by default.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const roles = require('../src/roles');
const { F } = H;

const tok = async (u) => (await H.loginConsole(u)).body.token;

before(H.start);
after(H.stop);

// ── LI-2: R10 is fully removed — no landing, no field rules, nothing dangling ─
test('v1.5 LI-2: R10 (Clinic) is removed from the role model entirely', () => {
  assert.ok(!('R10' in roles.LANDING), 'R10 has no landing entry');
  assert.deepEqual(roles.landingFor('R10').modules, [], 'an R10 session lands nowhere');
  for (const [field, set] of Object.entries(roles.FIELD_RULES)) {
    assert.ok(!set.includes('R10'), `${field} does not reference R10`);
  }
  // HR Officer absorbed the clinic modules.
  for (const mod of ['health_safety', 'medical', 'permits']) {
    assert.ok(roles.moduleAllowed('R03', mod), `R03 holds ${mod} (absorbed from clinic)`);
  }
});

// ── LI-5 (OPEN): R03 now receives medical/permit confidential fields ─────────
test('v1.5 LI-5: HR Officer (R03) receives medical_notes/permits — pinned, pending Kira ratify', async () => {
  // Unit: the A3 field matrix.
  const row = { id: 'x', full_name: 'X', medical_notes: 'note', permits: 'CS-1', pay_grade: 'G1', bank_account: 'B' };
  const seen = roles.visibleProfile('R03', row);
  assert.equal(seen.medical_notes, 'note', 'R03 sees medical_notes (v1.5 widening)');
  assert.equal(seen.permits, 'CS-1', 'R03 sees permits');
  assert.ok(!('pay_grade' in seen) && !('bank_account' in seen), 'R03 still has NO pay visibility');

  // HTTP: the real profile — HR Officer reads CAROL's medical fields.
  const hr = await tok(F.USERS.HR_A); // R03, site A1 = CAROL's site
  const p = (await H.req('GET', `/employees/${F.EMP.CAROL}`, { token: hr })).body;
  assert.equal(p.osha_status, 'cleared', 'R03 receives medical data through the API (LI-5)');
  assert.equal(p.permit_no, 'CS-1182');
  assert.ok(!('basic_pay' in p) && !('bank_account' in p), 'pay still absent for R03');
});

// ── v1.5: CEO/Executive (R14) — read-only, org-wide, NO individual pay ───────
test('v1.5 LI-4: CEO (R14) lands read-only on dashboard+reports and gets NO individual pay', async () => {
  // Unit: landing + no field rules + no actions.
  assert.deepEqual(roles.landingFor('R14').modules, ['dashboard', 'reports'], 'CEO modules are oversight-only');
  for (const set of Object.values(roles.FIELD_RULES)) assert.ok(!set.includes('R14'), 'CEO is in NO confidential field rule');
  for (const action of Object.keys(roles.ACTIONS)) {
    assert.equal(roles.canPerform('R14', action), false, `CEO cannot perform ${action} (read-only)`);
  }

  // HTTP: landing, org-wide reports access, refused actions, and a profile read
  // that must carry NO pay, NO medical, NO disciplinary — base fields only.
  const ceo = await tok(F.USERS.CEO_A);
  const landing = (await H.req('GET', '/me/landing', { token: ceo })).body;
  assert.deepEqual(landing.modules, ['dashboard', 'reports']);
  assert.equal((await H.req('GET', '/reports/summary', { token: ceo })).status, 200, 'org-wide reports allowed');
  assert.equal((await H.req('POST', '/action/payroll.run', { token: ceo })).status, 403, 'no payroll powers');
  assert.equal((await H.req('POST', '/action/admin.config.write', { token: ceo })).status, 403, 'no admin powers');

  const p = await H.req('GET', `/employees/${F.EMP.CAROL}`, { token: ceo });
  assert.equal(p.status, 200, 'org-wide oversight includes the directory profile');
  for (const field of ['basic_pay', 'bank_account', 'bank_name', 'osha_status', 'permit_no', 'disciplinary']) {
    assert.ok(!(field in p.body), `CEO profile read omits ${field} (LI-4 default: no individual pay/medical)`);
  }
  assert.equal(p.body.full_name, 'Carol Confidential', 'base fields present');

  // Financial registers stay pay-gated: the CEO is NOT in a3.pay.roles.
  assert.equal((await H.req('GET', '/reports/register/payroll/00000000-0000-0000-0000-000000000000', { token: ceo })).status, 403,
    'CEO refused the payroll register (module reports is not a pay backdoor)');
});

// ── LI-3 (addendum): R08/R09 removed; Finance Manager (R15) + CFC (R16) added ─
test('v1.5 LI-3: R08/R09 are removed; R15/R16 carry finance+payroll and pay visibility', async () => {
  for (const gone of ['R08', 'R09']) {
    assert.ok(!(gone in roles.LANDING), `${gone} has no landing entry`);
    assert.deepEqual(roles.landingFor(gone).modules, [], `${gone} lands nowhere`);
    for (const [field, set] of Object.entries(roles.FIELD_RULES)) {
      assert.ok(!set.includes(gone), `${field} does not reference ${gone}`);
    }
  }
  for (const code of ['R15', 'R16']) {
    assert.deepEqual(roles.landingFor(code).modules, ['dashboard', 'finance', 'payroll', 'reports']);
  }
  // Pay/bank visibility is EXACTLY Payroll Officer + HR Director + FM + CFC —
  // not CEO (R14), not HR Officer (R03).
  assert.deepEqual([...roles.FIELD_RULES.pay_grade].sort(), ['R07', 'R11', 'R15', 'R16']);
  assert.deepEqual([...roles.FIELD_RULES.bank_account].sort(), ['R07', 'R11', 'R15', 'R16']);

  // HTTP: the Finance Manager and CFC receive pay fields on a real profile read
  // ... but stay OUT of the directory list (directory.deny.roles, finance class).
  for (const u of [F.USERS.FINMGR_A, F.USERS.CFC_A]) {
    const t = await tok(u);
    const p = (await H.req('GET', `/employees/${F.EMP.CAROL}`, { token: t }));
    assert.equal(p.status, 403, `${u.role} is directory-denied like its predecessors (list/profile routes)`);
    // Pay visibility is exercised where finance actually works: the registers.
    assert.equal((await H.req('GET', '/reports/catalogue', { token: t })).body.pay_visible, true,
      `${u.role} is pay-visible (a3.pay.roles) — sees the financial registers`);
  }
});

// ── LI-6 (addendum): payroll.run belongs to finance; admin may NOT run payroll ─
test('v1.5 LI-6: payroll.run = Finance Manager + CFC; R12 admin and old R09 refused', async () => {
  assert.equal(roles.canPerform('R15', 'payroll.run'), true);
  assert.equal(roles.canPerform('R16', 'payroll.run'), true);
  assert.equal(roles.canPerform('R09', 'payroll.run'), false, 'retired R09 cannot run payroll');
  assert.equal(roles.canPerform('R12', 'payroll.run'), false, 'System Admin must NOT run payroll (explicit v1.5)');

  const fm = await tok(F.USERS.FINMGR_A);
  assert.equal((await H.req('POST', '/action/payroll.run', { token: fm })).status, 200, 'Finance Manager runs payroll');
  const admin = await tok(F.USERS.ADMIN_A);
  assert.equal((await H.req('POST', '/action/payroll.run', { token: admin })).status, 403, 'admin refused at the endpoint');
});
