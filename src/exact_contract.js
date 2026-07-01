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
  // EX-2 earnings/allowance components. Column POSITIONS confirmed against the
  // real Exact export are `pinned`; the fixed-pay components whose exact position
  // is not yet confirmed are provisional (not pinned) — but the daily-rate base is
  // resolved BY NAME (src/exact.js), so a position change is caught by the
  // name-keyed test rather than silently moving money.
  11: ['allowances', 'ROTATION', true],           // CONFIRMED — EXCLUDED from base
  12: ['allowances', 'BASIC SALARY', false],       // include (position provisional)
  13: ['allowances', 'HOUSING ALLOWANCE', false],  // include (position provisional)
  14: ['allowances', 'RESPONSIBILITY', false],     // include (position provisional)
  15: ['allowances', 'PROJECT', false],            // include (position provisional)
  16: ['allowances', 'MEDICAL', false],            // include (position provisional)
  17: ['allowances', 'HOUSING ALL', false],        // include (position provisional)
  19: ['allowances', 'FIXED OVERTIME', true],      // CONFIRMED — INCLUDED in base
  20: ['allowances', 'TRANSPORT', true],           // CONFIRMED — INCLUDED in base
  21: ['allowances', 'OVERTIME NORMAL', true],     // CONFIRMED — EXCLUDED from base
  24: ['allowances', 'OVERTIME HOLIDAY', true],    // CONFIRMED — EXCLUDED from base
  26: ['allowances', 'NIGHT SHIFT', true],         // CONFIRMED — EXCLUDED from base
  28: ['allowances', 'TOTAL PAY', true],           // EX-4: renamed from TOTAL ALLOWANCE
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
