'use strict';
// scripts/classify-expats.js — the CSV-driven is_expat backfill. Pins:
//   • an exact-one-candidate name match sets is_expat and flips the
//     employee's NULL permit docs to permit_type='expat';
//   • an unresolvable row is REPORTED, never guessed — and while any row is
//     unresolved the locals' business default is HELD (unclassified permits
//     keep failing closed to R11);
//   • with every row matched, locals' NULL permit docs default to 'business';
//   • stdout carries counts only — names go to the 600-mode report file.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'classify-expats.js');

before(H.start);
after(H.stop);

function run(csv, dir, extraEnv = {}) {
  const csvPath = path.join(dir, 'expat-permit-classification.csv');
  const reportPath = path.join(dir, 'report.txt');
  fs.writeFileSync(csvPath, csv);
  const out = execFileSync(process.execPath, [SCRIPT, csvPath, reportPath],
    { env: { ...process.env, UAT_COMPANY: A, ...extraEnv }, encoding: 'utf8' });
  return { out, report: fs.readFileSync(reportPath, 'utf8'), reportPath };
}

test('classify-expats: match sets the flag + expat docs; unmatched holds the local default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expat-'));
  const davePermit = (await owner(
    `INSERT INTO employee_document(company_id,employee_id,kind,name,valid_until)
     VALUES ($1,$2,'permit','Work permit',NULL) RETURNING id`, [A, F.EMP.DAVE])).rows[0].id;
  const carolPermit = (await owner(
    `INSERT INTO employee_document(company_id,employee_id,kind,name,valid_until)
     VALUES ($1,$2,'permit','Local business permit',NULL) RETURNING id`, [A, F.EMP.CAROL])).rows[0].id;
  try {
    // Round 1: Dave matches (reversed token order proves normalisation);
    // one bogus row stays unmatched → business default HELD.
    const r1 = run('Name,Passport,Nationality,Permit Expiry\n"SOUTHSITE DAVE",P1234567,ZA,2026-12-31\n"No Such Person",P0000000,IN,2026-12-31\n', dir);
    assert.match(r1.out, /expats matched\s*: 1/);
    assert.match(r1.out, /unmatched \(report file\) : 1/);
    assert.match(r1.out, /business : HELD/, 'locals default held while a row is unresolved');
    assert.ok(!r1.out.includes('SOUTHSITE') && !r1.out.includes('No Such Person'), 'stdout carries NO names');
    assert.match(r1.report, /No Such Person/, 'unmatched name lands in the report');
    assert.equal((fs.statSync(r1.reportPath).mode & 0o777), 0o600, 'report is 600');

    assert.equal((await owner('SELECT is_expat FROM employee WHERE id=$1', [F.EMP.DAVE])).rows[0].is_expat, true);
    assert.equal((await owner('SELECT permit_type FROM employee_document WHERE id=$1', [davePermit])).rows[0].permit_type, 'expat');
    assert.equal((await owner('SELECT permit_type FROM employee_document WHERE id=$1', [carolPermit])).rows[0].permit_type, null,
      'Carol\'s permit stays unclassified (fails closed to R11) while the list has unresolved rows');

    // The flag change is on the audit chain.
    const aud = (await owner(
      `SELECT count(*)::int n FROM audit WHERE company_id=$1 AND action='employee.expat.classify' AND entity_id=$2`,
      [A, F.EMP.DAVE])).rows[0].n;
    assert.ok(aud >= 1, 'is_expat backfill audited');

    // Round 2: every row matches → locals' NULL permits default to business.
    const r2 = run('Name,Passport,Nationality\n"Dave SouthSite",P1234567,ZA\n', dir);
    assert.match(r2.out, /business : \d+ \(locals' default applied\)/);
    assert.equal((await owner('SELECT permit_type FROM employee_document WHERE id=$1', [carolPermit])).rows[0].permit_type, 'business');
  } finally {
    await owner(`UPDATE employee SET is_expat=false WHERE id=$1`, [F.EMP.DAVE]);
    await owner('DELETE FROM employee_document WHERE id IN ($1,$2)', [davePermit, carolPermit]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
