'use strict';
// F7 — Controls & Checker (AC-AUD-03), built against Design spec #2. INTEGRATION
// tests through the real HTTP endpoint. Proves: the audit/controls view is guarded
// to the AUD/SOD set (controls.view.roles = R11/R12); each control reports a
// per-control checked-count (audit evidence) AND its offenders; a seeded breach
// flips a control to fail with the offender listed and the checked-count risen.
// A render assertion proves the all-clear grid is DISTINCT from fail-with-offenders.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;
const run = (token) => H.req('GET', '/controls', { token });
const byCheck = (body, name) => body.checks.find((c) => c.check === name);

async function importWeb(entry, deps = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const f of [entry, ...deps]) fs.copyFileSync(path.join(__dirname, '..', 'web', f), path.join(dir, f));
  return import(pathToFileURL(path.join(dir, entry)).href);
}

before(H.start);
after(H.stop);

// ── Guard: only the AUD/SOD set (R11/R12) may read the controls view ─────────
test('controls view is guarded to the AUD/SOD set (R11/R12); other roles refused', async () => {
  assert.equal((await run(await tok(F.USERS.EMP_A))).status, 403, 'employee (R01) refused');
  assert.equal((await run(await tok(F.USERS.PAYROLL_A))).status, 403, 'payroll (R07) refused — privileged but not AUD/SOD');
  assert.equal((await run(await tok(F.USERS.DIRECTOR_A))).status, 200, 'HR Director (R11) allowed');
  assert.equal((await run(await tok(F.USERS.ADMIN_A))).status, 200, 'System Admin (R12) allowed');
});

// ── Per-control checked-counts (evidence) + a seeded breach flips one control ─
test('controls report per-control checked-counts; a self-approval flips SoD to fail then clears', async () => {
  const admin = await tok(F.USERS.ADMIN_A);

  // Every control reports a numeric checked-count and coherent pass/offenders.
  const base = (await run(admin)).body;
  for (const c of base.checks) {
    assert.equal(typeof c.checked, 'number', `${c.check} reports a checked-count (audit evidence)`);
    assert.ok(Array.isArray(c.offenders));
    assert.equal(c.pass, c.offenders.length === 0, `${c.check} pass reflects offenders`);
    assert.ok(c.checked >= c.offenders.length, 'offenders are a subset of the checked population');
  }
  const sod0 = byCheck(base, 'sod.self_approval').checked;

  // Seed a SoD breach: an approved field change whose checker == maker.
  const fcId = (await owner(
    `INSERT INTO field_change(company_id,employee_id,field,before,after,maker,maker_role,status,checker,decided_at)
     VALUES ($1,$2,'phone','1','2','self@a.example','R03','approved','self@a.example',now()) RETURNING id`,
    [A, F.EMP.CAROL])).rows[0].id;
  try {
    const bad = (await run(admin)).body;
    const sod = byCheck(bad, 'sod.self_approval');
    assert.equal(sod.pass, false, 'SoD control now fails');
    assert.equal(sod.checked, sod0 + 1, 'checked-count rose by the added approved change (evidence, not just fail)');
    assert.ok(sod.offenders.some((o) => o.id === fcId), 'the self-approved change is listed as an offender');
    assert.equal(bad.all_pass, false, 'overall not all-clear when any control fails');
  } finally {
    await owner(`DELETE FROM field_change WHERE id=$1`, [fcId]);
  }

  // Cleared: the control passes again and reports its checked-count as evidence.
  const after = (await run(admin)).body;
  const sodA = byCheck(after, 'sod.self_approval');
  assert.equal(sodA.checked, sod0, 'checked-count back to baseline');
  assert.ok(!sodA.offenders.some((o) => o.id === fcId), 'the offender is gone');
});

// ── Render (spec #2): all-clear grid is DISTINCT from fail-with-offenders ─────
test('controls render: all-clear evidence grid is distinct from the fail-with-offenders grid', async () => {
  const { controlsView } = await importWeb('controls.js', ['api.js']);

  const clear = controlsView({ all_pass: true, checks: [{ check: 'sod.self_approval', checked: 5, pass: true, offenders: [] }] });
  assert.match(clear, /data-state="all-clear"/, 'all green → the all-clear grid');
  assert.match(clear, /5 checked, 0 offenders/, 'per-control checked-count shown as evidence');
  assert.doesNotMatch(clear, /data-state="findings"/);

  const fail = controlsView({ all_pass: false, checks: [
    { check: 'sod.self_approval', checked: 3, pass: false, offenders: [{ id: 'x1' }] },
    { check: 'audit.chain_integrity', checked: 9, pass: true, offenders: [] },
  ] });
  assert.match(fail, /data-state="findings"/, 'any failure → the fail-with-offenders grid');
  assert.match(fail, /offender/, 'offenders are listed');
  assert.match(fail, /x1/, 'the offending row is rendered');
  assert.doesNotMatch(fail, /data-state="all-clear"/, 'findings grid is NOT the all-clear grid');
});
