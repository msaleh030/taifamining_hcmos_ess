'use strict';
// Wave 5 (2026-07-14): confidentiality + CEO read-only.
//   • CEO read-only (auth.readonly.roles) is STRUCTURAL — a read-only role is
//     barred at the HTTP guard from EVERY mutating route, regardless of the
//     route's own guards; the one exception is a route flagged `readonlyOk`
//     (R14's expatriate field-change decision).
//   • A CONFIDENTIAL profile read leaves an audit trail (profile.read + which
//     blocks were disclosed); a base-directory-only read does NOT, so ordinary
//     browsing does not flood the chain. Forward-only: the hash chain still
//     recomputes.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const F = require('./fixtures');
const db = require('../src/db');

const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;
const setRO = (csv) => owner(
  `INSERT INTO config(company_id,key,value) VALUES ($1,'auth.readonly.roles',$2)
   ON CONFLICT (company_id,key) DO UPDATE SET value=EXCLUDED.value`, [F.TENANT_A, csv]);

test.before(async () => { await H.start(); });
test.after(async () => { await setRO('R14'); await H.stop(); });

const XPAT = 'a0000000-0000-0000-0000-00000000e8b5';
async function withExpat(fn) {
  await owner(
    `INSERT INTO employee (id, company_id, site_id, full_name, role_code, status, is_expat, phone)
     VALUES ($1,$2,$3,'Zz W5 Expat','R01','active',true,'0700008888')`,
    [XPAT, F.TENANT_A, F.SITE.A1]);
  try { await fn(); } finally {
    await owner(`DELETE FROM field_change WHERE employee_id=$1`, [XPAT]);
    await owner(`DELETE FROM employee WHERE id=$1`, [XPAT]);
  }
}

test('CEO read-only guard is STRUCTURAL and config-driven: the same role+route flips 200→403 by membership', async () => {
  await withExpat(async () => {
    const r11 = await tok(F.USERS.DIRECTOR_A); // Head of HR — the legitimate expat MAKER (200 baseline)
    await setRO('R14'); // default posture

    // Baseline: R11 may raise an expat field-change (it is the expat maker).
    const base = await H.req('POST', `/employees/${XPAT}/change`, { token: r11, body: { field: 'phone', value: '0711110000' } });
    assert.equal(base.status, 200, `baseline raise must succeed: ${JSON.stringify(base.body)}`);
    await owner(`DELETE FROM field_change WHERE employee_id=$1`, [XPAT]);

    // Put R11 into the read-only set — the SAME POST is now barred structurally.
    await setRO('R11,R14');
    const blocked = await H.req('POST', `/employees/${XPAT}/change`, { token: r11, body: { field: 'phone', value: '0711110001' } });
    assert.equal(blocked.status, 403, 'a read-only role is barred from the mutating route');
    // …but a GET is untouched (read-only means read).
    const read = await H.req('GET', `/employees/${XPAT}`, { token: r11 });
    assert.equal(read.status, 200, 'read-only role still READS');

    // Lift the membership — the write path is restored (proves it was the guard, not another denial).
    await setRO('R14');
    const restored = await H.req('POST', `/employees/${XPAT}/change`, { token: r11, body: { field: 'phone', value: '0711110002' } });
    assert.equal(restored.status, 200, 'removing the role from the set restores the write');
    await owner(`DELETE FROM field_change WHERE employee_id=$1`, [XPAT]);
  });
});

test('R14 (CEO) is read-only everywhere EXCEPT the readonlyOk expat decision', async () => {
  await setRO('R14');
  await withExpat(async () => {
    const r11 = await tok(F.USERS.DIRECTOR_A);
    const r14 = await tok(F.USERS.CEO_A);

    // A non-exception mutating route is barred for R14 (even a plain local change).
    const change = await H.req('POST', `/employees/${F.EMP.CAROL}/change`, { token: r14, body: { field: 'phone', value: '0700000099' } });
    assert.equal(change.status, 403, 'R14 cannot raise a field change (not a readonlyOk route)');

    // The ONE exception: R14 decides an expat field-change (readonlyOk) — raised by R11.
    const sub = await H.req('POST', `/employees/${XPAT}/change`, { token: r11, body: { field: 'phone', value: '0711110003' } });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    const approve = await H.req('POST', `/field-change/${sub.body.id}/approve`, { token: r14 });
    assert.equal(approve.status, 200, 'R14 CAN decide the expat change (the single deliberate exception)');
    assert.equal(approve.body.applied, true);
  });
});

test('confidential read-audit: a pay-visible read logs profile.read + blocks; a base-only read logs nothing; chain holds', async () => {
  const seqOf = async () => (await owner(`SELECT coalesce(max(seq),0)::int n FROM audit WHERE company_id=$1`, [F.TENANT_A])).rows[0].n;

  // R07 (pay + national_id visible, central) reads Carol → a confidential disclosure.
  const before = await seqOf();
  const r07 = await tok(F.USERS.PAYROLL_A);
  const paid = await H.req('GET', `/me/profile/${F.EMP.CAROL}`, { token: r07 });
  assert.equal(paid.status, 200);
  assert.ok('basic_pay' in paid.body, 'R07 receives the pay block');
  const rec = (await owner(
    `SELECT role, after FROM audit
      WHERE company_id=$1 AND action='profile.read' AND entity_id=$2 AND seq>$3
      ORDER BY seq DESC LIMIT 1`, [F.TENANT_A, F.EMP.CAROL, before])).rows[0];
  assert.ok(rec, 'a profile.read audit row was written for the confidential read');
  assert.equal(rec.role, 'R07');
  assert.ok(rec.after.blocks.includes('pay'), 'the disclosed blocks include pay');
  assert.ok(rec.after.blocks.includes('national_id'), 'and national_id (R07 is in both sets)');

  // R14 (CEO) reads Carol → base directory only, NO confidential block → NO read-audit.
  const before2 = await seqOf();
  const r14 = await tok(F.USERS.CEO_A);
  const oversight = await H.req('GET', `/me/profile/${F.EMP.CAROL}`, { token: r14 });
  assert.equal(oversight.status, 200);
  assert.ok(!('basic_pay' in oversight.body), 'R14 gets NO pay block');
  const none = (await owner(
    `SELECT count(*)::int n FROM audit
      WHERE company_id=$1 AND action='profile.read' AND entity_id=$2 AND seq>$3`,
    [F.TENANT_A, F.EMP.CAROL, before2])).rows[0].n;
  assert.equal(none, 0, 'a base-only read leaves NO profile.read trail');

  // The hash chain still recomputes after the forward-only read-audit rows.
  const chainOk = (await owner(`
    SELECT bool_and(hash = encode(sha256(convert_to(prev_hash || concat_ws('|',
      company_id::text, coalesce(actor,''), coalesce(role,''), action,
      coalesce(entity,''), coalesce(entity_id,''), ts::text,
      coalesce(before::text,''), coalesce(after::text,'')), 'UTF8')),'hex')) AS ok
      FROM audit WHERE company_id=$1`, [F.TENANT_A])).rows[0].ok;
  assert.equal(chainOk, true, 'audit chain recompute holds after read-audit rows');
});
