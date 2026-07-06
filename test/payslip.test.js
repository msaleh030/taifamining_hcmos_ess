'use strict';
// E6 — ESS payslip (PRT-02). Pins:
//   • a payslip appears in ESS only when its batch is PUBLISHED and the ESS
//     push leg has POSTED (C18) — staged and ESS-failed batches are invisible,
//     and a scoped leg retry makes the payslip appear without re-publishing;
//   • OWN-ONLY: no employee parameter exists; another user gets their own
//     empty state and a 404 for someone else's batch id — never the payslip;
//   • wording is law: totals speak total_pay / total_deduction / net_pay with
//     Net Pay = Total Pay − Total Deduction (the EXACT-07 identity);
//   • earnings/deductions itemize the file's nonzero component columns.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const exact = require('../src/exact');
const payslip = require('../src/payslip');
const contractDef = require('../src/exact_contract');
const { F } = H;

const A = F.TENANT_A;
const finance = { company_id: A, user_id: F.USERS.FINMGR_A.id, role_code: 'R15' };
const alice = { company_id: A, user_id: F.USERS.EMP_A.id, role_code: 'R01' };     // employee ALICE
const frank = { company_id: A, user_id: F.USERS.FIELD_A.id, role_code: 'R13' };   // employee FIELDA
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));

const CONTRACT = contractDef.build();
const N = CONTRACT.length;
function grid(dataRows) {
  const g = [['Exact Payroll Export', ...Array(N - 1).fill('')]];
  for (let i = 0; i < 4; i++) g.push(Array(N).fill(''));
  g.push(CONTRACT.map((c) => c.section.toUpperCase()));
  g.push(CONTRACT.map((c) => c.header));
  for (const d of dataRows) g.push(d);
  return g;
}
// Alice's pay row: Total Pay (28) 1,200,000 − Total Deduction (42) 350,000 =
// Net Pay (44) 850,000 — satisfies the per-row EXACT-07 identity.
function aliceRow(over = {}) {
  const r = Array(N).fill('0');
  r[0] = 'E-A-0001'; r[1] = 'Alice Admin'; r[3] = '2020-01-01'; r[4] = 'Admin';
  r[12] = '900000';  // BASIC SALARY
  r[13] = '150000';  // HOUSING ALLOWANCE
  r[20] = '150000';  // TRANSPORT
  for (const [k, v] of Object.entries(over)) r[k] = v;
  r[28] = '1200000'; // GROSS (file label TOTAL ALLOWANCE) — served as total_pay
  r[31] = '120000';  // NSSF
  r[32] = '230000';  // PAYE
  r[42] = '350000';  // TOTAL DEDUCTION
  r[44] = '850000';  // NET PAY
  return r;
}

before(H.start);
after(H.stop);

async function cleanup(batchIds) {
  for (const id of batchIds.filter(Boolean)) {
    await owner('DELETE FROM gl_posting WHERE batch_id=$1', [id]);
    await owner('DELETE FROM ess_push WHERE batch_id=$1', [id]);
    await owner('DELETE FROM exact_batch WHERE id=$1', [id]); // cascades rows + legs
  }
}

test('E6: payslip appears only after publish + ESS push; own-only; wording pinned', async () => {
  const ids = [];
  try {
    // Staged only → invisible (batch-addressed: other suites leave published
    // batches behind, so the pin targets THIS batch, not global emptiness).
    const staged = await exact.stage(finance, { period: '2026-05-e6', grid: grid([aliceRow()]) });
    ids.push(staged.batch_id);
    await exact.match(finance, staged.batch_id);
    await assert.rejects(payslip.getOwn(alice, staged.batch_id), /no payslip/, 'staged batch is not a payslip');

    // Published but the ESS leg FAILED → still invisible (C18 is the gate).
    const pub = await exact.publish(finance, staged.batch_id, { faultLeg: 'ess' });
    assert.equal(pub.legs.ess.status, 'failed');
    await assert.rejects(payslip.getOwn(alice, staged.batch_id), /no payslip/, 'ESS-failed batch is not a payslip');

    // Scoped retry posts the ESS leg → the payslip appears (no re-publish).
    const retry = await exact.retryPublishLegs(finance, staged.batch_id);
    assert.equal(retry.legs.ess.status, 'posted');
    const got = await payslip.getOwn(alice, staged.batch_id);
    assert.ok(got.payslip, 'payslip visible after the ESS leg posts');
    assert.equal(got.payslip.period, '2026-05-e6');

    // Wording + identity: total_pay / total_deduction / net_pay.
    const t = got.payslip.totals;
    assert.deepEqual(t, { total_pay: 1200000, total_deduction: 350000, net_pay: 850000 });
    assert.equal(t.net_pay, t.total_pay - t.total_deduction, 'Net Pay = Total Pay − Total Deduction');
    assert.ok(!('total_allowance' in t), 'never "Total Allowance"');

    // Earnings/deductions itemize the nonzero component columns (not the totals).
    const labels = (xs) => xs.map((x) => x.label).sort();
    assert.deepEqual(labels(got.payslip.earnings), ['BASIC SALARY', 'HOUSING ALLOWANCE', 'TRANSPORT']);
    assert.deepEqual(labels(got.payslip.deductions), ['NSSF', 'PAYE']);
    assert.ok(!labels(got.payslip.earnings).includes('TOTAL ALLOWANCE'), 'gross column is a total, not an earning line');

    // OWN-ONLY: Frank has no row in the batch — his view is empty, and asking
    // for Alice's batch id by hand is a 404, never her payslip.
    assert.equal((await payslip.getOwn(frank)).payslip, null, 'no payslip for a different employee');
    await assert.rejects(payslip.getOwn(frank, staged.batch_id), /no payslip/, 'own-only: 404 on someone else\'s batch');
    assert.equal((await payslip.listOwn(frank)).periods.length, 0);

    // History (large-data): a second published period lists newest-first
    // (compared within THIS test's batches — other suites leave their own).
    // Different composition (stage is idempotent BY FILE HASH — an identical
    // grid would return the already-published first batch), same totals.
    const staged2 = await exact.stage(finance, { period: '2026-06-e6', grid: grid([aliceRow({ 12: '850000', 13: '200000' })]) });
    ids.push(staged2.batch_id);
    await exact.match(finance, staged2.batch_id);
    await exact.publish(finance, staged2.batch_id);
    const hist = (await payslip.listOwn(alice)).periods;
    const i1 = hist.findIndex((p) => p.batch_id === staged2.batch_id);
    const i0 = hist.findIndex((p) => p.batch_id === staged.batch_id);
    assert.ok(i1 >= 0 && i0 >= 0, 'both periods listed');
    assert.ok(i1 < i0, 'newest first');
    assert.equal(hist[i1].net_pay, 850000);

    // A session with no employee record is refused, not given an empty slip.
    await assert.rejects(payslip.getOwn({ company_id: A, user_id: null, role_code: 'R12' }), /no employee/);
  } finally {
    await cleanup(ids);
  }
});

test('E6 endpoints: /me/payslip + /me/payslips serve the session\'s own data over HTTP', async () => {
  const ids = [];
  try {
    const staged = await exact.stage(finance, { period: '2026-07-e6http', grid: grid([aliceRow({ 12: '800000', 13: '250000' })]) });
    ids.push(staged.batch_id);
    await exact.match(finance, staged.batch_id);
    await exact.publish(finance, staged.batch_id);

    const tok = async (u) => (await H.loginConsole(u)).body.token;
    const aliceTok = await tok(F.USERS.EMP_A);
    const frankTok = await tok(F.USERS.FIELD_A);

    assert.equal((await H.req('GET', '/me/payslip')).status, 401, 'auth required');

    const mine = await H.req('GET', '/me/payslip', { token: aliceTok });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.payslip.totals.net_pay, 850000);
    assert.equal(mine.body.payslip.employee.full_name, 'Alice Admin');

    const list = await H.req('GET', '/me/payslips', { token: aliceTok });
    assert.equal(list.status, 200);
    assert.ok(list.body.periods.some((p) => p.batch_id === staged.batch_id));

    // Own-only over HTTP: Frank asking for Alice's batch gets 404.
    const theft = await H.req('GET', `/me/payslip?batch=${staged.batch_id}`, { token: frankTok });
    assert.equal(theft.status, 404, 'a payslip is never returned to anyone but its owner');
  } finally {
    await cleanup(ids);
  }
});
