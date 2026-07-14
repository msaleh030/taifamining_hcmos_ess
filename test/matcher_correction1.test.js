'use strict';
// CORRECTION 1 (Kira 2026-07-14) — the pay-component MATCHER, not just the names.
// "The bug is not the wording, it is SUBSTRING MATCHING."
//   a. include_names / exclude_names resolve by EXACT, CASE-INSENSITIVE match on
//      the literal Exact header string. No substrings. No abbreviations. No
//      fuzzy resolution (whitespace is NOT tidied).
//   b. HARD FAIL, not warn: a configured name resolving to ZERO columns (the
//      MEDICAL phantom) or MORE THAN ONE column (a duplicated header — the
//      HOUSING ambiguity) makes the ingest REFUSE TO RUN (409). Silence is what
//      caused this.
//   c. Auto-detection stays: every allowance column carrying money must sit in
//      exactly one list (include/exclude/pending) or the base blocks, naming it
//      (pinned in leave_base_ex2.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const exact = require('../src/exact');
const contractDef = require('../src/exact_contract');
const { F } = H;

const A = F.TENANT_A;
const session = { company_id: A, user_id: F.USERS.FINMGR_A.id, role_code: 'R15' };
const N = contractDef.build().length;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const setCfg = (k, v) => owner(
  `INSERT INTO config(company_id,key,value) VALUES ($1,$2,$3)
   ON CONFLICT (company_id,key) DO UPDATE SET value=EXCLUDED.value`, [A, k, v]);
const INCLUDE = 'exact.dailyrate.include_names';
const EXCLUDE = 'exact.dailyrate.exclude_names';
const INCLUDE_SIX = 'Basic Salary,Fixed Overtime,Project Allowance,Responsibility Allowance,Housing Allowance (Fixed),Transport Allowance(Fixed)';
const EXCLUDE_NINE = 'Rotation Allowance,Night Allowance,Overtime - Normal Days,Overtime - Holidays,Transport Allowance(variable),House Allowance(Variable),Gross Salary Arrears,Terminal Dues,Overdraft';
const is409 = (re) => (e) => e.status === 409 && re.test(e.message);

before(H.start);
after(async () => { await setCfg(INCLUDE, INCLUDE_SIX); await setCfg(EXCLUDE, EXCLUDE_NINE); await H.stop(); });

// ── Pure resolution semantics (no DB) ───────────────────────────────────────
test('resolution is EXACT and CASE-INSENSITIVE on the literal header — no substrings, no whitespace tidying', () => {
  const map = exact.headerMultimap([
    { position: 10, header: 'Basic Salary' },
    { position: 18, header: 'Housing Allowance (Fixed)' },
  ]);
  // case-insensitive exact match resolves
  const ok = exact.resolveConfiguredNames(map, 'bASIC sALARY', 'test');
  assert.equal(ok.get('BASIC SALARY'), 10);
  // a SUBSTRING never resolves ('Housing' is not a component)
  assert.throws(() => exact.resolveConfiguredNames(map, 'Housing', 'test'), is409(/ZERO contract columns/));
  // whitespace is NOT tidied: a missing/extra space is a DIFFERENT string
  assert.throws(() => exact.resolveConfiguredNames(map, 'Housing Allowance(Fixed)', 'test'),
    is409(/ZERO contract columns/), 'no space before the bracket ≠ the contract header');
  assert.throws(() => exact.resolveConfiguredNames(map, 'Housing  Allowance (Fixed)', 'test'),
    is409(/ZERO contract columns/), 'a double space is not collapsed away');
});

test('a duplicated contract header makes any name over it resolve AMBIGUOUSLY — hard fail naming both columns', () => {
  const map = exact.headerMultimap([
    { position: 13, header: 'Housing Allowance' },
    { position: 18, header: 'HOUSING ALLOWANCE' },   // duplicate after case-fold
  ]);
  assert.throws(() => exact.resolveConfiguredNames(map, 'Housing Allowance', 'test'),
    is409(/MORE THAN ONE contract column.*13,18/s));
});

// ── Zero-resolution (the MEDICAL phantom) refuses to run, end to end ────────
test('HARD FAIL on ZERO columns: a phantom include name (MEDICAL) blocks the base AND the upload', async () => {
  await setCfg(INCLUDE, `${INCLUDE_SIX},MEDICAL`);
  try {
    const cells = Array(N).fill('0'); cells[10] = '3000';
    await assert.rejects(exact.dailyRateBase(session, cells),
      is409(/include_names.*ZERO contract columns.*MEDICAL/s), 'base computation refuses');
    // the ingest itself refuses — a broken classification cannot stage a batch
    const grid = [contractDef.build().map((c) => c.header), cells];
    await assert.rejects(exact.stage(session, { period: '2026-07-c1', grid }),
      is409(/ZERO contract columns.*MEDICAL/s), 'upload refuses to run');
  } finally {
    await setCfg(INCLUDE, INCLUDE_SIX);
  }
});

test('HARD FAIL on ZERO columns applies to exclude_names too — a stale exclude name is never silently skipped', async () => {
  await setCfg(EXCLUDE, `${EXCLUDE_NINE},Ghost Component`);
  try {
    const cells = Array(N).fill('0'); cells[10] = '3000';
    await assert.rejects(exact.dailyRateBase(session, cells),
      is409(/exclude_names.*ZERO contract columns.*Ghost Component/s));
  } finally {
    await setCfg(EXCLUDE, EXCLUDE_NINE);
  }
});

// ── Ambiguous resolution (the HOUSING trap) refuses to run, end to end ──────
test('HARD FAIL on MORE THAN ONE column: a duplicated contract header blocks the base, naming both positions', async () => {
  // Plant a duplicate of 'Basic Salary' (case-folded) at a spare position.
  await owner(`INSERT INTO exact_column(version,position,section,header,pinned)
               VALUES ('v2.0', 90, 'allowances', 'BASIC SALARY', false)`);
  try {
    const cells = Array(N).fill('0'); cells[10] = '3000';
    await assert.rejects(exact.dailyRateBase(session, cells),
      is409(/include_names.*MORE THAN ONE contract column.*Basic Salary.*10,90/s));
  } finally {
    await owner(`DELETE FROM exact_column WHERE version='v2.0' AND position=90`);
  }
});

// ── The ratified production lists resolve one-to-one against v2.0 ───────────
test('the ratified six include + nine exclude + two pending names each resolve to EXACTLY ONE v2.0 column', async () => {
  const { include, exclude, pending } = await exact.classificationPositions(A);
  assert.equal(include.size, 6);
  assert.equal(exclude.size, 9);
  assert.equal(pending.size, 2);
  // evidenced anchors (header-map probe 2026-07-14)
  assert.equal(include.get('BASIC SALARY'), 10);
  assert.equal(include.get('TRANSPORT ALLOWANCE(FIXED)'), 19);
  assert.equal(exclude.get('OVERDRAFT'), 26);
  assert.equal(exclude.get('TERMINAL DUES'), 9);
  assert.equal(pending.get('LOCAL CONVEYANCE'), 23);
  assert.equal(pending.get('TSF ALLOWANCE'), 20);
  const all = [...include.values(), ...exclude.values(), ...pending.values()];
  assert.equal(new Set(all).size, all.length, 'no two names share a column');
});
