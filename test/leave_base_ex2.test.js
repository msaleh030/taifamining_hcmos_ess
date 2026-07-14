'use strict';
// EX-2 / LIAB-03 governance gate (Kira 2026-07-14). The leave-pay/liability
// figure must NEVER be a silent, possibly-wrong number:
//   1. FAIL-CLOSED — while the pay-component classification is not RATIFIED
//      (exact.dailyrate.classification.ratified ≠ 'true') the figure is NOT
//      AVAILABLE, naming the pending ratification.
//   2. UNCLASSIFIED — even once ratified, an allowance column that carries money
//      but is neither included nor excluded from the base is NOT AVAILABLE,
//      NAMING the component (Cecilia must classify it). Since the cent-round
//      ruling (Kira 2026-07-14: 'Previous Cent-Round Deduction' 25 + all cent
//      columns EXCLUDED — rounding carries, not earned pay) EVERY allowance
//      column is classified; the tests below synthesize the unclassified case
//      by dropping a component, and PIN the full coverage.
//   3. Only when ratified AND every populated pay column is classified does the
//      base compute — the same one base ÷30 the certified LIAB-01 math pins.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const liab = require('../src/liability');
const contractDef = require('../src/exact_contract');
const { F } = H;

const A = F.TENANT_A;
const N = contractDef.build().length;
const session = { company_id: A, user_id: F.USERS.FINMGR_A.id, role_code: 'R15' };
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const setCfg = (k, v) => owner(
  `INSERT INTO config(company_id,key,value) VALUES ($1,$2,$3)
   ON CONFLICT (company_id,key) DO UPDATE SET value=EXCLUDED.value`, [A, k, v]);
const RATIFIED = 'exact.dailyrate.classification.ratified';
const INCLUDE = 'exact.dailyrate.include_names';
// RATIFIED six (Kira 2026-07-14, official NM export — exact strings).
const INCLUDE_FULL = 'Basic Salary,Fixed Overtime,Project Allowance,Responsibility Allowance,Housing Allowance (Fixed),Transport Allowance(Fixed)';

function baseCells() { const c = Array(N).fill('0'); c[10] = '3000'; return c; } // Basic Salary (v2.0) only (classified)

before(H.start);
after(async () => { await setCfg(RATIFIED, '__TBC__'); await setCfg(INCLUDE, INCLUDE_FULL); await H.stop(); });

test('FAIL-CLOSED: while the EX-2 classification is not ratified, the figure is NOT AVAILABLE (named), never a number', async () => {
  await setCfg(INCLUDE, INCLUDE_FULL);
  await setCfg(RATIFIED, '__TBC__');
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells: baseCells() });
  assert.equal(r.available, false, 'not available while the classification is unratified');
  assert.match(r.missing, /ratification/i, 'the reason names the pending ratification');
  assert.ok(!('liability' in r), 'never a figure while unratified');
});

test('UNCLASSIFIED: money in a pay column neither included nor excluded → NOT AVAILABLE naming the component', async () => {
  await setCfg(RATIFIED, 'true');
  // Drop Transport Allowance(Fixed) from include WITHOUT excluding it → unclassified.
  await setCfg(INCLUDE, 'Basic Salary,Fixed Overtime,Project Allowance,Responsibility Allowance,Housing Allowance (Fixed)');
  const cells = baseCells(); cells[19] = '500'; // Transport Allowance(Fixed) (v2.0 position 19) carries money — unclassified
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells });
  assert.equal(r.available, false, 'an unclassified non-zero pay column blocks the figure');
  assert.match(r.missing, /Transport Allowance\(Fixed\)/, 'the reason names the unclassified component');
  // A zero in the same unclassified column does NOT block (no money → nothing to classify).
  await setCfg(RATIFIED, 'true');
  const zero = baseCells(); // Transport Allowance(Fixed) (19) = '0'
  const rz = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells: zero });
  assert.equal(rz.available, true, 'a zero in an unclassified column is not money to classify');
});

test('PENDING CECILIA: money in a pending-named component blocks the figure NAMING the governance hold', async () => {
  await setCfg(RATIFIED, 'true');
  await setCfg(INCLUDE, INCLUDE_FULL);
  // v2.0 carries the REAL pending components by name — Local Conveyance (23)
  // and TSF Allowance (20) ('Local Conveyance,TSF Allowance', Kira 2026-07-14
  // — do not guess). No stand-in needed: pin the production hold directly.
  const cells = baseCells(); cells[23] = '25000'; // Local Conveyance carries money
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells });
  assert.equal(r.available, false, 'a pending component with money blocks the figure');
  assert.match(r.missing, /pending Cecilia/, 'the reason names the governance hold');
  assert.match(r.missing, /Local Conveyance/, 'and the component');

  const both = baseCells(); both[23] = '25000'; both[20] = '133088'; // TSF Allowance too
  const r2 = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells: both });
  assert.equal(r2.available, false);
  assert.match(r2.missing, /Local Conveyance/);
  assert.match(r2.missing, /TSF Allowance/, 'every pending component with money is named');
});

test('GROSS-TRAP sanity: the base is the SIX ratified components, never gross — variable money never enters', async () => {
  await setCfg(RATIFIED, 'true');
  await setCfg(INCLUDE, INCLUDE_FULL);
  // A row where gross-style thinking is 33% wrong: base components 3000, plus
  // variable/excluded money (rotation 500, variable house 300, OT 200) = gross 4000.
  const cells = baseCells();          // Basic Salary (10) = 3000
  cells[22] = '500';                  // Rotation Allowance — EXCLUDED
  cells[17] = '300';                  // House Allowance(Variable) — EXCLUDED
  cells[15] = '200';                  // Overtime - Normal Days — EXCLUDED
  const exact = require('../src/exact');
  const base = await exact.dailyRateBase(session, cells);
  assert.equal(base, 3000, 'base = the six ratified components only');
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells });
  assert.equal(r.available, true, JSON.stringify(r));
  assert.equal(r.daily_rate, 100, 'daily = base/30 (3000/30), NOT gross/30 (4000/30≈133) — the 33% gross trap');
});

test('RATIFIED + fully classified: the figure computes (10 × 3000/30 = 1000) from the one EX-2 base', async () => {
  await setCfg(RATIFIED, 'true');
  await setCfg(INCLUDE, INCLUDE_FULL);
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells: baseCells() });
  assert.equal(r.available, true, JSON.stringify(r));
  assert.equal(r.daily_rate, 100, '3000 / 30');
  assert.equal(r.liability, 1000, '10 × 100');
});

// ── Cent-round ruling (Kira 2026-07-14): ALL cent-round columns are EXCLUDED
// from the base — a rounding carry is not earned pay. They live in the Net
// formula (Net = TotAllow − TotDeduct + CentRoundUp − CentRoundDown), never
// the base. Byte-identical headers: 25 Previous Cent-Round Deduction,
// 28 Cent Round Up, 41 Previous Cent-Round Payment, 43 Cent Round Down.
test('CENT-ROUND: money in any cent-round column neither blocks nor enters the base (EXCLUDED, ruled)', async () => {
  await setCfg(RATIFIED, 'true');
  await setCfg(INCLUDE, INCLUDE_FULL);
  const exact = require('../src/exact');
  const cells = baseCells();           // Basic Salary (10) = 3000
  cells[25] = '117';                   // Previous Cent-Round Deduction — the old auto-block
  cells[28] = '3'; cells[43] = '2';    // Cent Round Up / Down
  cells[41] = '55';                    // Previous Cent-Round Payment
  const r = await liab.liabilityFor(session, { employeeId: F.EMP.DAVE, days: 10, cells });
  assert.equal(r.available, true, `cent-round money must not block: ${JSON.stringify(r)}`);
  assert.equal(await exact.dailyRateBase(session, cells), 3000, 'and never enters the base');
});

// ── Full coverage (the ruling's own check): after the cent-round exclusion,
// NO allowance column can auto-block — every one resolves to a ruled list.
// Local Conveyance (23) + TSF Allowance (20) sit in PENDING (Cecilia's gate,
// closed on purpose) — classified as gated, not silently unclassified.
test('COVERAGE: every allowances-section column is classified (include/exclude/pending/gross) — none auto-blocks', async () => {
  await setCfg(INCLUDE, INCLUDE_FULL);
  const exact = require('../src/exact');
  const cfgMod = require('../src/config');
  const { include, exclude, pending, rows } = await exact.classificationPositions(A);
  const normH = (s) => String(s || '').trim().toUpperCase();
  const gross = normH(await cfgMod.getConfig(A, 'exact.dailyrate.gross_name', 'TOTAL ALLOWANCE', null));
  const orphans = rows
    .filter((c) => c.section === 'allowances')
    .filter((c) => { const h = normH(c.header);
      return h !== gross && !include.has(h) && !exclude.has(h) && !pending.has(h); })
    .map((c) => `${c.position}:${c.header}`);
  assert.deepEqual(orphans, [], `unclassified allowance column(s) remain: ${orphans.join(', ')}`);
  // The ONLY gate left is Cecilia's — exactly these two, nothing else.
  assert.deepEqual([...pending.keys()].sort(), ['LOCAL CONVEYANCE', 'TSF ALLOWANCE']);
});

// ── Float determinism (Kira 2026-07-14): fixed column order + integer cents,
// one division at the end. The base cannot move by a shilling with the ORDER
// of anything — config string, row, column. 0.1+0.2-class decimals included.
test('DETERMINISM: the base is identical under any include-list order, exact on float-trap decimals', async () => {
  await setCfg(RATIFIED, 'true');
  const exact = require('../src/exact');
  const cells = baseCells();
  cells[10] = '1000000.10'; cells[12] = '0.20'; cells[13] = '0.30';   // 0.1+0.2 ≠ 0.3 in float64
  cells[14] = '333333.33'; cells[18] = '0.07'; cells[19] = '123456.78';
  await setCfg(INCLUDE, INCLUDE_FULL);
  const forward = await exact.dailyRateBase(session, cells);
  await setCfg(INCLUDE, INCLUDE_FULL.split(',').reverse().join(','));
  const reversed = await exact.dailyRateBase(session, cells);
  assert.equal(forward, reversed, 'config-order permutation cannot move the base');
  assert.equal(forward, 1456790.78, 'exact to the cent (integer-cents accumulation, one division)');
  await setCfg(INCLUDE, INCLUDE_FULL);
});
