'use strict';
// Kira scope rulings (2026-07-12, second):
//   • R04/R07/R12/R14/R15/R16 are CENTRAL (site_scope, migration 031) — with
//     R06/R11 already central; the site-bound tier stays R01/R02/R03/R05/R13.
//   • STRICTLY only the Head of HR (R11) performs CRUD on expatriate records:
//     a non-R11 may neither RAISE nor DECIDE a field change on an is_expat
//     employee, and an expat's permit documents are R11-only in the doc list
//     (the DA-2 R11-only alert leg, extended). Local employees are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const F = require('./fixtures');
const db = require('../src/db');

const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;

test.before(async () => { await H.start(); });
test.after(async () => { await H.stop(); });

const XPAT = 'a0000000-0000-0000-0000-00000000e8a7';

async function withExpat(fn) {
  await owner(
    `INSERT INTO employee (id, company_id, site_id, full_name, role_code, status, is_expat, phone)
     VALUES ($1, $2, $3, 'Zz Expat Subject', 'R01', 'active', true, '0700009999')`,
    [XPAT, F.TENANT_A, F.SITE.A1]);
  try { await fn(); } finally {
    await owner(`DELETE FROM field_change WHERE employee_id=$1`, [XPAT]);
    await owner(`DELETE FROM employee_document WHERE employee_id=$1`, [XPAT]);
    await owner(`DELETE FROM employee WHERE id=$1`, [XPAT]);
  }
}

test('central-scope ruling: R04/R07/R12/R14/R15/R16 are scoped=false in site_scope; R03 stays site-bound', async () => {
  const r = await owner(
    `SELECT role_code, scoped FROM site_scope
      WHERE role_code IN ('R03','R04','R07','R12','R14','R15','R16') ORDER BY role_code`);
  const byRole = Object.fromEntries(r.rows.map((x) => [x.role_code, x.scoped]));
  for (const central of ['R04', 'R07', 'R12', 'R14', 'R15', 'R16'])
    assert.equal(byRole[central], false, `${central} must be CENTRAL (scoped=false)`);
  assert.equal(byRole.R03, true, 'R03 stays site-bound (the multi-site SET is user_site_scope rows, not central scope)');
});

test('expat CRUD gate: only R11 raises; only R14 decides (Kira: Omid raises, Richard decides); locals unchanged', async () => {
  await withExpat(async () => {
    const r03 = await tok(F.USERS.HR_A);        // site A1 HR Officer — maker for locals
    const r04 = await tok(F.USERS.HR2_A);       // central HR Manager — maker for locals
    const r11 = await tok(F.USERS.DIRECTOR_A);  // Head of HR — the ONLY expat maker
    const r14 = await tok(F.USERS.CEO_A);       // CEO/Executive — the ONLY expat checker

    // Non-R11 makers are refused — R03 in-site and R04 central reach the expat
    // gate (they ARE makers); R14 falls at the generic maker check first.
    for (const [who, t] of [['R03', r03], ['R04', r04]]) {
      const res = await H.req('POST', `/employees/${XPAT}/change`, { token: t, body: { field: 'phone', value: '0711111111' } });
      assert.equal(res.status, 403, `${who} must be refused as maker`);
      assert.match(res.body.error, /Head of HR/, `${who} refusal names the ruling`);
    }
    const ceoMake = await H.req('POST', `/employees/${XPAT}/change`, { token: r14, body: { field: 'phone', value: '0711111111' } });
    assert.equal(ceoMake.status, 403, 'R14 is a checker for expats, never a maker');

    // R11 raises the change (R11 is a maker since this ruling).
    const sub = await H.req('POST', `/employees/${XPAT}/change`, { token: r11, body: { field: 'phone', value: '0711111111' } });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.pending, true);

    // Only R14 decides an expat change: R04 (a generic checker) and even the
    // R11 maker tier are refused — the CEO set REPLACES the generic checkers.
    for (const [who, t] of [['R04', r04], ['R11', r11]]) {
      const res = await H.req('POST', `/field-change/${sub.body.id}/approve`, { token: t });
      assert.equal(res.status, 403, `${who} must be refused as expat checker`);
      assert.match(res.body.error, /CEO\/Executive/, `${who} refusal names the checker ruling`);
    }

    // R14 approves — Omid raises, Richard decides.
    const ok = await H.req('POST', `/field-change/${sub.body.id}/approve`, { token: r14 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.applied, true);
    const phone = await owner(`SELECT phone FROM employee WHERE id=$1`, [XPAT]);
    assert.equal(phone.rows[0].phone, '0711111111', 'the R14-approved change applied');

    // Locals are untouched by BOTH sides of the gate: R03 raises, R04 approves,
    // and R14 stays refused (he is the EXPAT checker, not a generic one).
    const local = await H.req('POST', `/employees/${F.EMP.CAROL}/change`, { token: r03, body: { field: 'phone', value: '0700000002' } });
    assert.equal(local.status, 200, 'local employee CRUD unchanged');
    const localCeo = await H.req('POST', `/field-change/${local.body.id}/approve`, { token: r14 });
    assert.equal(localCeo.status, 403, 'R14 is not a checker for LOCAL changes');
    const localOk = await H.req('POST', `/field-change/${local.body.id}/approve`, { token: r04 });
    assert.equal(localOk.status, 200, 'generic checker path unchanged for locals');
  });
});

test('expat permit documents are R11-only in the document list; a local\'s permits stay with the medical A3 set', async () => {
  await withExpat(async () => {
    await owner(
      `INSERT INTO employee_document (company_id, employee_id, kind, name, valid_until)
       VALUES ($1, $2, 'permit', 'Zz Work Permit', '2027-01-01'), ($1, $2, 'contract', 'Zz Contract', '2027-01-01')`,
      [F.TENANT_A, XPAT]);
    const r03 = await tok(F.USERS.HR_A);   // in a3.medical.roles — sees a LOCAL's permits
    const r11 = await tok(F.USERS.DIRECTOR_A);

    const forR03 = await H.req('GET', `/employees/${XPAT}/documents`, { token: r03 });
    assert.equal(forR03.status, 200);
    assert.ok(!forR03.body.documents.some((d) => d.kind === 'permit'), 'expat permit hidden from R03');
    assert.ok(forR03.body.documents.some((d) => d.kind === 'contract'), 'non-permit docs still visible');

    const forR11 = await H.req('GET', `/employees/${XPAT}/documents`, { token: r11 });
    assert.equal(forR11.status, 200);
    assert.ok(forR11.body.documents.some((d) => d.kind === 'permit' && d.name === 'Zz Work Permit'),
      'Head of HR sees the expat permit');

    // A LOCAL employee's permit stays visible to the medical A3 set (R06 business leg).
    await owner(
      `INSERT INTO employee_document (company_id, employee_id, kind, name, valid_until)
       VALUES ($1, $2, 'permit', 'Zz Local Business Permit', '2027-01-01')`, [F.TENANT_A, F.EMP.CAROL]);
    try {
      const local = await H.req('GET', `/employees/${F.EMP.CAROL}/documents`, { token: r03 });
      assert.ok(local.body.documents.some((d) => d.name === 'Zz Local Business Permit'),
        'local permits unchanged for the A3 medical set');
    } finally {
      await owner(`DELETE FROM employee_document WHERE name='Zz Local Business Permit'`);
    }
  });
});
