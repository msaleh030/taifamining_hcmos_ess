'use strict';
// C17 Reports — the financial gate, server-side. The Payroll and Leave-liability
// REGISTERS carry the C16 pay-visibility gate (a3.pay.roles), NOT the broad
// 'reports' module — a report inherits the gate of its data. Proven at the
// endpoint: pay-visibility roles get the register; a site role (R03), a reports-
// module role (R04), and even the CEO (R14, org-wide oversight) are all 403 unless they
// are in the pay-visibility set. The catalogue hides financial entries from non-pay.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const contractDef = require('../src/exact_contract');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;
const N = contractDef.build().length;

// EX-2 gate (Kira 2026-07-14): ratify the pay-component classification so the
// leave-liability register certifies its total (fail-closed behaviour is proved
// in leave_base_ex2.test.js).
const ratify = (v) => owner(
  `INSERT INTO config(company_id,key,value) VALUES ($1,'exact.dailyrate.classification.ratified',$2)
   ON CONFLICT (company_id,key) DO UPDATE SET value=EXCLUDED.value`, [A, v]);
before(async () => { await H.start(); await ratify('true'); });
after(async () => { await ratify('__TBC__'); await H.stop(); });

test('C17 registers inherit the C16 pay-gate server-side; catalogue hides financials from non-pay', async () => {
  // A batch with one matched row: base 3000 (col 10, v2.0) and net 2000 (col 44),
  // plus 10 carry days for DISS → liability 10 × (3000/30) = 1000.
  const setup = await db.withOwner(async (c) => {
    const b = (await c.query(
      `INSERT INTO exact_batch(company_id,period,file_hash,version,status,row_count)
       VALUES ($1,'2026-06-rep','rep-hash-1','v2.0','published',1) RETURNING id`, [A])).rows[0];
    const cells = Array(N).fill('0'); cells[10] = '3000'; cells[44] = '2000';
    await c.query(
      `INSERT INTO exact_row(company_id,batch_id,row_no,employee_id_raw,full_name,cells,matched_employee,match_status)
       VALUES ($1,$2,1,'x','',$3,$4,'matched')`, [A, b.id, JSON.stringify(cells), F.EMP.DISS]);
    const lc = (await c.query(
      `INSERT INTO leave_carry(company_id,employee_id,days,carried_for_year) VALUES ($1,$2,10,2026) RETURNING id`, [A, F.EMP.DISS])).rows[0];
    return { batchId: b.id, carryId: lc.id };
  });
  const payReg = `/reports/register/payroll/${setup.batchId}`;
  const liabReg = `/reports/register/leave-liability/${setup.batchId}`;
  try {
    // Pay-visibility role (R07) → gets both registers.
    const pay = await tok(F.USERS.PAYROLL_A);
    const pr = await H.req('GET', payReg, { token: pay });
    assert.equal(pr.status, 200);
    assert.equal(pr.body.total, 2000, 'payroll register nets col AS');
    assert.ok(pr.body.lines.some((l) => l.employee_id === F.EMP.DISS && l.net === 2000));
    const lr = await H.req('GET', liabReg, { token: pay });
    assert.equal(lr.status, 200);
    assert.equal(lr.body.total, 1000, 'leave-liability register from the one base ÷30');

    // The financial gate is STRONGER than the module: every non-pay role is 403,
    // even one that holds the 'reports' or 'payroll' module.
    for (const [user, who] of [
      [F.USERS.HR_A, 'R03 site HR (no reports module)'],
      [F.USERS.HR2_A, 'R04 HR Manager (has reports, not pay)'],
      [F.USERS.CEO_A, 'R14 CEO (has reports, org-wide oversight, not pay)'],
    ]) {
      const t = await tok(user);
      assert.equal((await H.req('GET', payReg, { token: t })).status, 403, `payroll register 403 for ${who}`);
      assert.equal((await H.req('GET', liabReg, { token: t })).status, 403, `leave-liability register 403 for ${who}`);
    }

    // Catalogue: a pay role sees the financial registers; a reports-only role does not.
    const catPay = await H.req('GET', '/reports/catalogue', { token: pay });
    assert.equal(catPay.body.pay_visible, true);
    assert.ok(catPay.body.reports.some((r) => r.id === 'payroll' && r.financial));
    assert.ok(catPay.body.reports.some((r) => r.id === 'leave-liability'));

    const catHr = await H.req('GET', '/reports/catalogue', { token: await tok(F.USERS.HR2_A) }); // R04 has reports
    assert.equal(catHr.status, 200, 'reports-module role sees the catalogue');
    assert.equal(catHr.body.pay_visible, false);
    assert.ok(!catHr.body.reports.some((r) => r.financial), 'no financial register listed for a non-pay role');
  } finally {
    await owner(`DELETE FROM leave_carry WHERE id=$1`, [setup.carryId]);
    await owner(`DELETE FROM exact_row WHERE batch_id=$1`, [setup.batchId]);
    await owner(`DELETE FROM exact_batch WHERE id=$1`, [setup.batchId]);
  }
});

// ── Organogram (Kira ruling 2026-07-12): positional BY DESIGN — job titles,
// not person links — with the limitation stated in the output itself. Site-
// scoped through the shared gate; directory-tier data only. ──────────────────
test('organogram is positional (title-based), states its limitation, and site-scopes a bound viewer', async () => {
  // Titled employees at TWO sites (the seed carries no positions).
  const mk = (name, site, pos, rt) => owner(
    `INSERT INTO employee(company_id, site_id, full_name, role_code, status, position, reports_to_title)
     VALUES ($1,$2,$3,'R01','active',$4,$5) RETURNING id`, [A, site, name, pos, rt]);
  const e1 = (await mk('Zz Org One', F.SITE.A1, 'Zz Operator', 'Zz Site Manager')).rows[0].id;
  const e2 = (await mk('Zz Org Two', F.SITE.A1, 'Zz Site Manager', null)).rows[0].id;
  const e3 = (await mk('Zz Org Three', F.SITE.HO, 'Zz Accountant', 'Zz CFO')).rows[0].id;
  try {
    // Central role with the reports module (R11) sees every site's chart.
    const central = await H.req('GET', '/reports/organogram', { token: await tok(F.USERS.DIRECTOR_A) });
    assert.equal(central.status, 200);
    assert.equal(central.body.basis, 'position-hierarchy');
    assert.ok(/cannot say WHICH/.test(central.body.limitation), 'the positional limitation is stated in the output');
    const allRows = Object.values(central.body.sites).flat();
    assert.ok(Object.keys(central.body.sites).length >= 2, 'central viewer sees multiple sites');
    const op = allRows.find((n) => n.position === 'Zz Operator');
    assert.ok(op && op.reports_to_title === 'Zz Site Manager', 'the edge is position → reports_to_title (verbatim)');
    for (const n of allRows) {
      assert.deepEqual(Object.keys(n).sort(), ['headcount', 'position', 'reports_to_title'],
        'directory-tier fields only — no names, no pay, no PII');
    }
    // A site-bound viewer with the reports module (R02 Supervisor) sees ONLY her site.
    const sup = await H.req('GET', '/reports/organogram', { token: await tok(F.USERS.SUP_A) });
    assert.equal(sup.status, 200);
    const supRows = Object.values(sup.body.sites).flat();
    assert.ok(supRows.some((n) => n.position === 'Zz Operator'), 'her own site is present');
    assert.ok(!supRows.some((n) => n.position === 'Zz Accountant'), 'another site\'s chart is NOT visible');
  } finally {
    for (const id of [e1, e2, e3]) await owner(`DELETE FROM employee WHERE id=$1`, [id]);
  }
});
