'use strict';
// Exact payroll column contract (registry v1.2 appendix). This module is the SEED
// SOURCE for the exact_column table; validation reads the contract from the table
// at runtime, so a version bump is a data change, not a code deploy.
//
// Positions are 0-indexed (the appendix labels EMPLOYEE ID as 00). The named
// positions below are CONFIRMED from the appendix and are `pinned` (their header
// text is enforced on upload). Un-named positions carry a canonical placeholder
// header and are NOT pinned — their exact appendix labels still need reconciling.
//
// NOTE (flagged): the appendix cites position 49 (WCF) with SDL at 48, i.e. a
// 0..49 grid = 50 physical columns, while the summary says "49 cols". The column
// COUNT here derives from the contract length, so correcting it is a one-line
// change to LAST_POSITION (or the seeded rows) — no code edit elsewhere.
const VERSION = 'v1.2';
const LAST_POSITION = 49; // inclusive → 50 columns (see NOTE above)

// position -> [section, exact header] for the CONFIRMED/named columns.
const NAMED = {
  0:  ['identity', 'EMPLOYEE ID'],
  1:  ['identity', 'FULL NAME'],
  3:  ['identity', 'EMPLOYMENT DATE'],
  4:  ['identity', 'DEPARTMENT'],
  7:  ['identity', 'NIDA'],
  9:  ['identity', 'TIN'],
  10: ['identity', 'PENSION/NSSF NO'],
  28: ['allowances', 'TOTAL ALLOWANCE'],
  31: ['deductions', 'NSSF'],
  32: ['deductions', 'PAYE'],
  42: ['deductions', 'TOTAL DEDUCTION'],
  45: ['employer', 'NSSF'],
  47: ['employer', 'NHIF'],
  48: ['employer', 'SDL'],
  49: ['employer', 'WCF'],
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
    cols.push({ version: VERSION, position: p, section, header, pinned: !!named });
  }
  return cols;
}

module.exports = { VERSION, LAST_POSITION, NAMED, build };
