'use strict';
// F3 — leave/liability as INTEGRATION tests through the real HTTP endpoints.
// LV-01/02/05, LIAB-01/02/03, LR-7: liability from the ONE name-keyed base ÷30
// (active-only, not-available for missing remuneration), the liability endpoint
// guarded to the pay-visibility role set, and sick leave drawing a separate bucket.
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
const round1 = (x) => Math.round(x * 10) / 10;

// A cells array whose EX-2 name-keyed base sums to `base` (Basic Salary at col 12).
function cellsWithBase(base) {
  const c = Array(N).fill('0');
  c[12] = String(base); // BASIC SALARY (an included component)
  return c;
}

before(H.start);
after(H.stop);

// ── LIAB-01/02/03 + LV-02 (guarded) via HTTP ────────────────────────────────
test('liability endpoint: figure from the single base, missing→not-available, leaver excluded, pay-guarded', async () => {
  // Isolated batch: DISS (active, base 3000, 10 carry days) → 10 × (3000/30) = 1000;
  // DCHK (active, no remuneration) → not-available; TERM (leaver) → excluded.
  const setup = await db.withOwner(async (c) => {
    const b = (await c.query(
      `INSERT INTO exact_batch(company_id,period,file_hash,version,status,row_count)
       VALUES ($1,'2026-06-f3','f3-hash-1','v1.2','staged',3) RETURNING id`, [A])).rows[0];
    const row = (emp, cells, no) => c.query(
      `INSERT INTO exact_row(company_id,batch_id,row_no,employee_id_raw,full_name,cells,matched_employee,match_status)
       VALUES ($1,$2,$3,'x','',$4,$5,'matched')`, [A, b.id, no, JSON.stringify(cells), emp]);
    await row(F.EMP.DISS, cellsWithBase(3000), 1);
    await row(F.EMP.DCHK, cellsWithBase(0), 2);      // no remuneration
    await row(F.EMP.TERM, cellsWithBase(3000), 3);   // leaver (terminated)
    const lc = (await c.query(
      `INSERT INTO leave_carry(company_id,employee_id,days,carried_for_year) VALUES ($1,$2,10,2026) RETURNING id`, [A, F.EMP.DISS])).rows[0];
    return { batchId: b.id, carryId: lc.id };
  });
  try {
    // pay-visibility role → 200, hand-calculated figure through HTTP
    const pay = await tok(F.USERS.PAYROLL_A); // R07 ∈ a3.pay.roles
    const r = await H.req('GET', `/liability/batch/${setup.batchId}`, { token: pay });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 1000, 'total from the single base ÷30 × 10 days');
    const diss = r.body.available.find((a) => a.employee_id === F.EMP.DISS);
    assert.equal(diss.daily_rate, 100, '3000 / 30');
    assert.equal(diss.liability, 1000);
    // missing remuneration → not-available card, input named (not zero, not absent)
    const na = r.body.not_available.find((n) => n.employee_id === F.EMP.DCHK);
    assert.ok(na && na.missing === 'monthly remuneration');
    // leaver excluded from the total
    assert.ok(r.body.excluded.some((x) => x.employee_id === F.EMP.TERM));
    assert.ok(!r.body.available.some((a) => a.employee_id === F.EMP.TERM));

    // a role WITHOUT pay-visibility is refused at the endpoint (pay-adjacent guard)
    const nopay = await tok(F.USERS.HR_A); // R03 ∉ a3.pay.roles
    const denied = await H.req('GET', `/liability/batch/${setup.batchId}`, { token: nopay });
    assert.equal(denied.status, 403, 'liability restricted to the pay-visibility set');
  } finally {
    await owner(`DELETE FROM leave_carry WHERE id=$1`, [setup.carryId]);
    await owner(`DELETE FROM exact_batch WHERE id=$1`, [setup.batchId]); // cascades exact_row
  }
});

// ── LR-7 / LV-01/05: sick leave draws a SEPARATE bucket, never annual ────────
test('sick leave draws its own bucket via the endpoint; annual is untouched', async () => {
  const t = await tok(F.USERS.EMP_A); // self-service (employee Alice)
  try {
    const b0 = (await H.req('GET', '/leave/balance', { token: t })).body;
    const annual0 = b0.annual.available;
    // LR-7 CONFIRMED (v1.4): sick = 63 full + 63 half = 126 entitlement, cert day 1.
    assert.equal(b0.sick.entitlement, 126, 'sick entitlement is the loaded LR-7 rule');
    assert.equal(b0.sick.full_pay_days, 63);
    assert.equal(b0.sick.half_pay_days, 63);
    assert.equal(b0.sick.certificate_from_day, 1);
    assert.equal(b0.sick.available, round1(126 - b0.sick.taken), 'sick available is a number, not not-available');

    // apply SICK — must not touch annual
    const sick = await H.req('POST', '/leave/apply', { token: t, body: { leave_type: 'sick', days: 3 } });
    assert.equal(sick.status, 200);
    const b1 = (await H.req('GET', '/leave/balance', { token: t })).body;
    assert.equal(b1.annual.available, annual0, 'annual balance unchanged by sick leave');
    assert.equal(b1.sick.taken, b0.sick.taken + 3, 'sick bucket increased');
    assert.equal(b1.sick.available, round1(126 - b1.sick.taken), 'sick available drops with taken');

    // apply ANNUAL — reduces annual, not sick
    const ann = await H.req('POST', '/leave/apply', { token: t, body: { leave_type: 'annual', days: 5 } });
    assert.equal(ann.status, 200);
    const b2 = (await H.req('GET', '/leave/balance', { token: t })).body;
    assert.equal(b2.annual.available, annual0 - 5, 'annual reduced by the annual request');
    assert.equal(b2.sick.taken, b1.sick.taken, 'sick unchanged by annual leave');

    // LR-5: an annual request over the max-continuous without HoH override is refused
    const tooLong = await H.req('POST', '/leave/apply', { token: t, body: { leave_type: 'annual', days: 15 } });
    assert.equal(tooLong.status, 409, 'exceeds max continuous without HoH override');
  } finally {
    await owner(`DELETE FROM leave_request WHERE employee_id=$1`, [F.EMP.ALICE]);
  }
});

// ── LR-2: a period in months converts to days on the confirmed 30-day basis ──
test('LR-2 a months-based sick request converts on the 30-day basis (loaded, not gated)', async () => {
  const t = await tok(F.USERS.EMP_A);
  try {
    const b0 = (await H.req('GET', '/leave/balance', { token: t })).body;
    // 1 month → 30 days on the LR-2 basis; sick draws its own bucket.
    const r = await H.req('POST', '/leave/apply', { token: t, body: { leave_type: 'sick', months: 1 } });
    assert.equal(r.status, 200, 'months request no longer blocks — LR-2 is loaded');
    assert.equal(r.body.days, 30, '1 month = 30 days (LR-2 30-day basis)');
    const b1 = (await H.req('GET', '/leave/balance', { token: t })).body;
    assert.equal(b1.sick.taken, b0.sick.taken + 30, 'sick bucket rose by the converted days');
  } finally {
    await owner(`DELETE FROM leave_request WHERE employee_id=$1`, [F.EMP.ALICE]);
  }
});
