'use strict';
// Exact payroll column contract (registry v1.2 appendix). This module is the SEED
// SOURCE for the exact_column table; validation reads the contract from the table
// at runtime, so a version bump is a data change, not a code deploy.
//
// Positions are 0-indexed (the appendix labels EMPLOYEE ID as 00). The named
// positions below are CONFIRMED from the appendix and are `pinned` (their header
// text is enforced on upload). Un-named positions carry a canonical placeholder
// header and are NOT pinned — their exact appendix labels still need reconciling.
// The base-driving positions (ROTATION=11, FIXED OVERTIME=19, TRANSPORT=20,
// OVERTIME NORMAL=21, OVERTIME HOLIDAY=24, NIGHT SHIFT=26) are pinned by
// test/exact.test.js ('EX-2 base is name-keyed'): a moved column fails that test.
//
// NOTE (flagged): the appendix cites position 49 (WCF) with SDL at 48, i.e. a
// 0..49 grid = 50 physical columns, while the summary says "49 cols". The column
// COUNT here derives from the contract length, so correcting it is a one-line
// change to LAST_POSITION (or the seeded rows) — no code edit elsewhere.
const VERSION = 'v1.2';
const LAST_POSITION = 49; // inclusive → 50 columns (see NOTE above)

// position -> [section, exact header, pinned]. `pinned` headers are enforced on
// upload. The earnings/allowance components (EX-2) are recorded so the daily-rate
// base and payslip labels are data-driven, but their POSITIONS are PROVISIONAL
// pending the appendix, so they are NOT pinned (real files aren't rejected on
// those labels). The confirmed identity/total/net columns ARE pinned.
const NAMED = {
  0:  ['identity', 'EMPLOYEE ID', true],
  1:  ['identity', 'FULL NAME', true],
  3:  ['identity', 'EMPLOYMENT DATE', true],
  4:  ['identity', 'DEPARTMENT', true],
  7:  ['identity', 'NIDA', true],
  9:  ['identity', 'TIN', true],
  10: ['identity', 'PENSION/NSSF NO', true],
  // EX-2 earnings/allowance components — headers RATIFIED against the OFFICIAL
  // North Mara Exact export (Kira, 2026-07-14, arithmetic over all 285 rows).
  // The prior provisional abbreviations (HOUSING ALLOWANCE / HOUSING ALL /
  // TRANSPORT / MEDICAL) were AMBIGUOUS against a contract that carries BOTH a
  // Fixed and a Variable housing and transport column — and MEDICAL was a
  // phantom (no such component exists). Exact header strings below, character
  // for character (matching is exact-after-normalisation, never substring).
  // Positions of the not-yet-position-confirmed components stay provisional
  // (not pinned); the base resolves BY NAME (src/exact.js).
  11: ['allowances', 'Rotation Allowance', true],            // EXCLUDED from base
  12: ['allowances', 'Basic Salary', false],                 // INCLUDE (position provisional)
  13: ['allowances', 'Housing Allowance (Fixed)', false],    // INCLUDE (position provisional)
  14: ['allowances', 'Responsibility Allowance', false],     // INCLUDE (position provisional)
  15: ['allowances', 'Project Allowance', false],            // INCLUDE (position provisional)
  // 16: MEDICAL removed — PHANTOM (Kira 2026-07-14): the official contract has
  // no medical component. Position 16 reverts to an un-named allowance slot;
  // money appearing there flags as unclassified (fail-closed), never summed.
  17: ['allowances', 'House Allowance(Variable)', false],    // EXCLUDED (position provisional)
  19: ['allowances', 'Fixed Overtime', true],                // INCLUDED in base
  20: ['allowances', 'Transport Allowance(Fixed)', true],    // INCLUDED in base (no space before bracket)
  21: ['allowances', 'Overtime - Normal Days', true],        // EXCLUDED from base
  24: ['allowances', 'Overtime - Holidays', true],           // EXCLUDED from base
  26: ['allowances', 'Night Allowance', true],               // EXCLUDED from base
  // v1.5 (North Mara reconciliation, supersedes EX-4): the file's label at 28 is
  // 'TOTAL ALLOWANCE' but the column is actually GROSS PAY (basic + ALL
  // allowances). It is mapped as GROSS (exact.col.gross) — NEVER also summed with
  // the individual allowance columns (double-count → the 827M nonsense gross).
  28: ['totals', 'TOTAL ALLOWANCE', true],
  31: ['deductions', 'NSSF', true],
  32: ['deductions', 'PAYE', true],
  42: ['deductions', 'TOTAL DEDUCTION', true],
  44: ['net', 'NET PAY', true],                          // EX-3: column AS (0-indexed 44)
  45: ['employer', 'NSSF', true],
  47: ['employer', 'NHIF', true],
  48: ['employer', 'SDL', true],
  49: ['employer', 'WCF', true],
};

// Section grouping for un-named positions (labels shown on the section row).
function sectionFor(pos) {
  if (pos <= 10) return 'identity';
  if (pos <= 28) return 'allowances';
  if (pos === 29) return 'spacer';
  if (pos <= 42) return 'deductions';
  if (pos <= 44) return 'spacer';
  return 'employer';
}

// Build the full contract (one entry per physical column).
function build() {
  const cols = [];
  for (let p = 0; p <= LAST_POSITION; p++) {
    const named = NAMED[p];
    const section = named ? named[0] : sectionFor(p);
    const header = named ? named[1] : `${section.toUpperCase()} ${p}`;
    cols.push({ version: VERSION, position: p, section, header, pinned: named ? !!named[2] : false });
  }
  return cols;
}

module.exports = { VERSION, LAST_POSITION, NAMED, build };
