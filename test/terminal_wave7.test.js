'use strict';
// Wave 7 (2026-07-14): terminal/severance dues + financial-register read-audit.
//   • the terminal register BLOCKS with 409 while the statutory rate
//     (terminal.severance.days_per_year) is PENDING — never a guessed figure;
//   • once the rate is confirmed it computes severance = dailyBasic × days/yr ×
//     completed years, from the SAME PC-1 base÷30 as leave liability, active-only;
//   • a financial-register disclosure (leave-liability / terminal) writes a
//     register.read audit row (the money registers bypass a3.assembleProfile, so
//     Wave 5's profile-read trail did not cover them); the hash chain still holds.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const terminal = require('../src/terminal');
const contractDef = require('../src/exact_contract');
const { F } = H;
// Kira 2026-07-14: the /liability/terminal HTTP route is PARKED (removed from the
// production surface — statutory exposure, never in Taifa scope). src/terminal.js
// stays on the branch; these tests exercise the engine DIRECTLY so the parked
// code keeps coverage if it is ever revived. The financial-gate (a3.pay.roles)
// was the route's guard and is retired with the route.
const sess = (role) => ({ company_id: A, role_code: role, user_id: F.USERS.PAYROLL_A.id });

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;
const N = contractDef.build().length;
const setDays = (v) => owner(
  `INSERT INTO config(company_id,key,value) VALUES ($1,'terminal.severance.days_per_year',$2)
   ON CONFLICT (company_id,key) DO UPDATE SET value=EXCLUDED.value`, [A, v]);

function cellsWithBase(base) { const c = Array(N).fill('0'); c[12] = String(base); return c; } // BASIC SALARY

before(H.start);
after(async () => { await setDays('__TBC__'); await H.stop(); });

async function withBatch(fn) {
  const setup = await db.withOwner(async (c) => {
    const b = (await c.query(
      `INSERT INTO exact_batch(company_id,period,file_hash,version,status,row_count)
       VALUES ($1,'2026-06-w7','w7-hash-1','v1.2','staged',3) RETURNING id`, [A])).rows[0];
    const row = (emp, cells, no) => c.query(
      `INSERT INTO exact_row(company_id,batch_id,row_no,employee_id_raw,full_name,cells,matched_employee,match_status)
       VALUES ($1,$2,$3,'x','',$4,$5,'matched')`, [A, b.id, no, JSON.stringify(cells), emp]);
    await row(F.EMP.DISS, cellsWithBase(3000), 1);  // active, base 3000
    await row(F.EMP.DCHK, cellsWithBase(0), 2);     // active, no remuneration
    await row(F.EMP.TERM, cellsWithBase(3000), 3);  // leaver (terminated)
    await c.query(`UPDATE employee SET joined_at='2023-01-01' WHERE id=$1`, [F.EMP.DISS]);
    return { batchId: b.id };
  });
  try { await fn(setup); } finally {
    await owner(`DELETE FROM exact_batch WHERE id=$1`, [setup.batchId]); // cascades exact_row
  }
}

test('terminal register BLOCKS with 409 while the statutory rate is PENDING', async () => {
  await setDays('__TBC__');
  await withBatch(async ({ batchId }) => {
    // Engine-level: a pending statutory rate must BLOCK (409), never guess a figure.
    await assert.rejects(
      terminal.batchSeverance(sess('R07'), batchId, '2026-07-14'),
      (e) => e.status === 409,
      'a pending statutory rate must BLOCK, never guess a severance figure');
  });
});

test('terminal dues compute once the rate is confirmed: dailyBasic×days/yr×completed years, active-only', async () => {
  await setDays('7'); // e.g. 7 days basic wage per completed year (TEST value, not a legal ruling)
  try {
    await withBatch(async ({ batchId }) => {
      const r = await terminal.batchSeverance(sess('R07'), batchId, '2026-07-14');
      const diss = r.available.find((a) => a.employee_id === F.EMP.DISS);
      assert.ok(diss, 'the active employee with a base is available');
      assert.equal(diss.daily_rate, 100, '3000 / 30');
      assert.equal(diss.completed_years, 3, '2023-01-01 → 2026-07-14 = 3 completed years');
      assert.equal(diss.severance, 2100, '100 × 7 days/yr × 3 years');
      // missing remuneration → not-available (named), never a silent zero
      assert.ok(r.not_available.some((n) => n.employee_id === F.EMP.DCHK && n.missing === 'monthly remuneration'));
      // leaver excluded from the provision
      assert.ok(r.excluded.some((x) => x.employee_id === F.EMP.TERM));
      assert.ok(!r.available.some((a) => a.employee_id === F.EMP.TERM));
    });
  } finally { await setDays('__TBC__'); }
});

test('financial-register reads are audited (register.read) and the chain still recomputes', async () => {
  await withBatch(async ({ batchId }) => {
    const before = (await owner(`SELECT coalesce(max(seq),0)::int n FROM audit WHERE company_id=$1`, [A])).rows[0].n;
    const pay = await tok(F.USERS.PAYROLL_A);
    const r = await H.req('GET', `/liability/batch/${batchId}`, { token: pay });
    assert.equal(r.status, 200);
    const rec = (await owner(
      `SELECT role, after FROM audit WHERE company_id=$1 AND action='register.read' AND entity_id=$2 AND seq>$3
        ORDER BY seq DESC LIMIT 1`, [A, batchId, before])).rows[0];
    assert.ok(rec, 'a register.read audit row was written for the leave-liability disclosure');
    assert.equal(rec.role, 'R07');
    assert.equal(rec.after.register, 'leave-liability');

    const chainOk = (await owner(`
      SELECT bool_and(hash = encode(sha256(convert_to(prev_hash || concat_ws('|',
        company_id::text, coalesce(actor,''), coalesce(role,''), action,
        coalesce(entity,''), coalesce(entity_id,''), ts::text,
        coalesce(before::text,''), coalesce(after::text,'')), 'UTF8')),'hex')) AS ok
        FROM audit WHERE company_id=$1`, [A])).rows[0].ok;
    assert.equal(chainOk, true, 'audit chain recompute holds after the register-read rows');
  });
});
