'use strict';
// Smart CSV parsing for the load-ingest loader — intelligent on FORMAT,
// uncompromising on TRUTH:
//   • the header row is AUTO-DETECTED even when buried under merged title rows
//     (the real North Mara master has it at row 8);
//   • columns map by recognised variants (EMPLOYEE ID/Payroll No → pf, FULL
//     NAME → name, DATE ENGAGED → hire_date, …);
//   • genuine ambiguity FAILS CLOSED: two columns claiming one field, or a
//     required field that cannot be found, refuse with a report — never a guess.
// Pure parsing — no DB, no server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseFile } = require('../scripts/load-ingest');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-'));
function csv(name, lines) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n'));
  return p;
}

test('auto-detects a header buried at row 8 under merged titles, mapping variant names', () => {
  const p = csv('messy.csv', [
    'TAIFA MINING COMPANY LTD,,,,,,,,',            // merged title debris
    ',,,,,,,,',
    'NORTH MARA GOLD MINE,,,,,,,,',
    'EMPLOYEE MASTER FILE,,,,,,,,',
    'AS AT 30 JUNE 2026,,,,,,,,',
    ',,,,,,,,',
    'CONFIDENTIAL,,,,,,,,',
    'EMPLOYEE ID,FULL NAME,LOCATION,JOB TITLE,DEPT,DATE ENGAGED,NIDA NO,TIN NO,BANK NAME', // ← row 8
    '3615,Gideon Owino Anyona,North Mara,Assistant Quantity Surveyor,Production,2022-01-13 19:25:45,19770205-16113-00001-20,116013487,CRDB',
    '3619,Meckson Cyprian Pamagila,North Mara,ADT Operator,Production,2022-01-13 19:43:30,,112624147,NMB',
  ]);
  const { rows, mapping } = parseFile('employee_master', p);
  assert.equal(mapping.header_row, 8, 'header found at row 8, not assumed at row 1');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pf, '3615', 'EMPLOYEE ID recognised as pf');
  assert.equal(rows[0].name, 'Gideon Owino Anyona', 'FULL NAME recognised as name');
  assert.equal(rows[0].site, 'North Mara', 'LOCATION recognised as site');
  assert.equal(rows[0].position, 'Assistant Quantity Surveyor', 'JOB TITLE recognised as position');
  assert.equal(rows[0].department, 'Production', 'DEPT recognised as department');
  assert.equal(rows[0].hire_date, '2022-01-13 19:25:45', 'DATE ENGAGED recognised as hire_date');
  assert.equal(rows[0].national_id, '19770205-16113-00001-20', 'NIDA NO recognised as national_id');
  assert.equal(rows[0].tin, '116013487', 'TIN NO recognised as tin');
  assert.equal(rows[0].bank, 'CRDB', 'BANK NAME recognised as bank');
});

test('the standard exact-name header at row 1 still parses (no regression)', () => {
  const p = csv('standard.csv', [
    'pf,name,site,position,department,hire_date,national_id,tin,bank',
    '4001,Test Person,North Mara,Mechanic,PLI & PED,2023-01-01,,123456789,NMB',
  ]);
  const { rows, mapping } = parseFile('employee_master', p);
  assert.equal(mapping.header_row, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pf, '4001');
  assert.equal(rows[0].position, 'Mechanic');
});

test('opening-balance variants map too (Payroll No / Leave Balance / Days Taken)', () => {
  const p = csv('ob.csv', [
    'Payroll No,Employee Name,Site,Leave Accrued,Days Taken,Leave Balance',
    '90070001,Balance Person,North Mara,10,2,8',
  ]);
  const { rows } = parseFile('opening_balance', p);
  assert.equal(rows[0].pf, '90070001');
  assert.equal(rows[0].balance, '8');
  assert.equal(rows[0].accrued, '10');
  assert.equal(rows[0].taken, '2');
});

test('FAIL-CLOSED: two columns claiming the same field is refused, not guessed', () => {
  const p = csv('ambiguous.csv', [
    'PF,EMPLOYEE ID,NAME,SITE',                    // PF and EMPLOYEE ID both → pf
    '1,2,Someone,North Mara',
  ]);
  assert.throws(() => parseFile('employee_master', p),
    /ambiguous header row 1: .*both map to pf.*refusing to guess/,
    'duplicate claims on one field are the operator\'s call, never the loader\'s');
});

test('FAIL-CLOSED: a required column that cannot be found is refused with a report', () => {
  const p = csv('missing.csv', [
    'EMPLOYEE ID,JOB TITLE,DEPT',                  // no name, no site
    '1,Mechanic,PLI & PED',
  ]);
  assert.throws(() => parseFile('employee_master', p), (e) => {
    assert.match(e.message, /no usable header row found/);
    assert.match(e.message, /missing required: name, site/, 'names exactly what could not be found');
    assert.match(e.message, /matched: pf, position, department/, 'and what WAS recognised');
    return true;
  });
});

test('unrecognised columns are ignored and reported, never silently absorbed', () => {
  const p = csv('extra.csv', [
    'pf,name,site,SHOE SIZE,position',
    '5001,Extra Person,North Mara,44,Welder',
  ]);
  const { rows, mapping } = parseFile('employee_master', p);
  assert.ok(mapping.unmapped_columns.includes('SHOE SIZE'), 'the unknown column is named in the report');
  assert.ok(!('SHOE SIZE' in rows[0]) && !Object.values(rows[0]).includes('44'), 'its data does not leak into any field');
  assert.equal(rows[0].position, 'Welder');
});

test('footer/total debris after the data is NOT dropped silently — it flows to the validators as rows', () => {
  const p = csv('footer.csv', [
    'pf,name,site',
    '6001,Real Person,North Mara',
    ',,',                                          // blank → skipped (no data at all)
    'TOTAL,285,',                                  // footer → kept; validator reports "PF not numeric"
  ]);
  const { rows } = parseFile('employee_master', p);
  assert.equal(rows.length, 2, 'blank rows skipped; content-bearing footer kept for the exception report');
  assert.equal(rows[1].pf, 'TOTAL', 'the footer reaches the validator, which reports it — the loader does not decide');
});

test('the mapping report is auditable: header row + which source header fed each field', () => {
  const p = csv('report.csv', [
    'Staff No,Names,Mine Site',
    '7001,Audit Person,North Mara',
  ]);
  const { mapping } = parseFile('employee_master', p);
  assert.equal(mapping.header_row, 1);
  assert.deepEqual(mapping.fields, { pf: 'Staff No', name: 'Names', site: 'Mine Site' });
});
