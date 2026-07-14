'use strict';
// Exact payroll column contract. This module is the SEED SOURCE for the
// exact_column table; validation reads the contract from the table at runtime,
// so a version bump is a data change, not a code deploy.
//
// ── v2.0 (ACTIVE) — the OFFICIAL Exact export layout, EVIDENCED ─────────────
// Header-map probe 2026-07-14 (run 29331947385) read the official North Mara
// export files on the UAT box position by position: 49 columns (0-indexed
// 0..48), column headers on ROW 1 (no title band, no section row), allowance
// components at 9..26, Total Allowances at 27, Cent Round Up at 28, deductions
// at 29..41, Total Deductions at 42, Cent Round Down at 43, Net Payment at 44,
// employer contributions at 45..48. Every header below is byte-identical to
// the file and PINNED (enforced on upload) — matching is exact,
// case-insensitive, never substring (Correction 1, Kira 2026-07-14).
//
// The v1.2 grid (registry appendix: 50 columns, title band, headers on row 7)
// NEVER matched this export — the ratified exclude names could not resolve
// against it, which the Correction-1 hard-fail made loud. v1.2 stays seeded
// (LEGACY_V12) so historical batches keep a readable contract; nothing new
// validates against it.
const VERSION = 'v2.0';

// position → [section, exact header]. All pinned (evidenced byte-identical).
// Sections drive the EX-2 classification sweep: every 'allowances' column
// carrying money must be include/exclude/pending-classified or the base blocks.
// 'rounding' columns (28/43) are Net-level (outside Total Allowances/Total
// Deductions) — the EX-3 net identity reads them by config position.
const NAMED = {
  0:  ['identity', 'Employee ID'],
  1:  ['identity', 'Full Name'],
  2:  ['identity', 'Current Position'],
  3:  ['identity', 'Employment Date'],
  4:  ['identity', 'Department Name'],
  5:  ['identity', 'Bank Name'],
  6:  ['identity', 'National ID Number'],
  7:  ['identity', 'TIN'],
  8:  ['identity', 'NSSF Number'],
  // Earnings band (sums to Total Allowances — Overdraft is an EARNING, ruled
  // 2026-07-14). Ratified base SIX: 10, 12, 13, 14, 18, 19. Ratified excluded
  // TEN: 9, 11, 15, 16, 17, 21, 22, 24, 25, 26. PENDING Cecilia: 20, 23.
  // Position 25 (Previous Cent-Round Deduction) is EXCLUDED (Kira 2026-07-14:
  // a rounding carry, not earned pay) — as are ALL cent-round columns (28, 41,
  // 43): they live in the Net formula, never the base.
  9:  ['allowances', 'Terminal Dues'],
  10: ['allowances', 'Basic Salary'],
  11: ['allowances', 'Gross Salary Arrears'],
  12: ['allowances', 'Fixed Overtime'],
  13: ['allowances', 'Project Allowance'],
  14: ['allowances', 'Responsibility Allowance'],
  15: ['allowances', 'Overtime - Normal Days'],
  16: ['allowances', 'Transport Allowance(variable)'],
  17: ['allowances', 'House Allowance(Variable)'],
  18: ['allowances', 'Housing Allowance (Fixed)'],
  19: ['allowances', 'Transport Allowance(Fixed)'],   // no space before bracket
  20: ['allowances', 'TSF Allowance'],
  21: ['allowances', 'Overtime - Holidays'],
  22: ['allowances', 'Rotation Allowance'],
  23: ['allowances', 'Local Conveyance'],
  24: ['allowances', 'Night Allowance'],
  25: ['allowances', 'Previous Cent-Round Deduction'],
  26: ['allowances', 'Overdraft'],
  27: ['totals', 'Total Allowances'],                 // GROSS (exact.col.gross)
  28: ['rounding', 'Cent Round Up'],                  // exact.col.roundup — evidenced, ex-[TBC]
  29: ['deductions', 'Due on Termination'],
  30: ['deductions', 'PAYE'],
  31: ['deductions', 'Mid-Month Advance'],
  32: ['deductions', 'NSSF Employee Contribution'],
  33: ['deductions', 'Workers Welfare Union'],
  34: ['deductions', 'Advance 2'],
  35: ['deductions', 'Absent Deduction'],
  36: ['deductions', 'ABSA Loan Repayment'],
  37: ['deductions', 'HESLB 15%'],
  38: ['deductions', 'Condolence Advance / Ndalo'],
  39: ['deductions', 'M-Donation'],
  40: ['deductions', 'NUMET'],
  41: ['deductions', 'Previous Cent-Round Payment'],
  42: ['totals', 'Total Deductions'],                 // exact.col.total_deduction
  43: ['rounding', 'Cent Round Down'],                // exact.col.rounddown — evidenced, ex-[TBC]
  44: ['net', 'Net Payment'],                         // exact.netpay.source col:44
  45: ['employer', 'NSSF Employer Contribution'],
  46: ['employer', 'NHIF Employer Contribution - Contribution Section'],
  47: ['employer', 'Skills and Development Levy'],
  48: ['employer', 'Workers Compensation Fund'],
};
const LAST_POSITION = 48; // inclusive → 49 physical columns (evidenced)

// Build the ACTIVE contract (one entry per physical column, all pinned).
function build() {
  const cols = [];
  for (let p = 0; p <= LAST_POSITION; p++) {
    const [section, header] = NAMED[p];
    cols.push({ version: VERSION, position: p, section, header, pinned: true });
  }
  return cols;
}

// ── v1.2 (LEGACY, seeded for historical batches only) ───────────────────────
// The registry-appendix grid as ratified through migration 037. Frozen here
// verbatim so a re-seed reproduces exactly what historical exact_batch rows
// (version='v1.2') were validated and published against.
const V12_NAMED = {
  0:  ['identity', 'EMPLOYEE ID', true],
  1:  ['identity', 'FULL NAME', true],
  3:  ['identity', 'EMPLOYMENT DATE', true],
  4:  ['identity', 'DEPARTMENT', true],
  7:  ['identity', 'NIDA', true],
  9:  ['identity', 'TIN', true],
  10: ['identity', 'PENSION/NSSF NO', true],
  11: ['allowances', 'Rotation Allowance', true],
  12: ['allowances', 'Basic Salary', false],
  13: ['allowances', 'Housing Allowance (Fixed)', false],
  14: ['allowances', 'Responsibility Allowance', false],
  15: ['allowances', 'Project Allowance', false],
  17: ['allowances', 'House Allowance(Variable)', false],
  19: ['allowances', 'Fixed Overtime', true],
  20: ['allowances', 'Transport Allowance(Fixed)', true],
  21: ['allowances', 'Overtime - Normal Days', true],
  24: ['allowances', 'Overtime - Holidays', true],
  26: ['allowances', 'Night Allowance', true],
  28: ['totals', 'TOTAL ALLOWANCE', true],
  31: ['deductions', 'NSSF', true],
  32: ['deductions', 'PAYE', true],
  42: ['deductions', 'TOTAL DEDUCTION', true],
  44: ['net', 'NET PAY', true],
  45: ['employer', 'NSSF', true],
  47: ['employer', 'NHIF', true],
  48: ['employer', 'SDL', true],
  49: ['employer', 'WCF', true],
};

function v12SectionFor(pos) {
  if (pos <= 10) return 'identity';
  if (pos <= 28) return 'allowances';
  if (pos === 29) return 'spacer';
  if (pos <= 42) return 'deductions';
  if (pos <= 44) return 'spacer';
  return 'employer';
}

function buildV12() {
  const cols = [];
  for (let p = 0; p <= 49; p++) {
    const named = V12_NAMED[p];
    const section = named ? named[0] : v12SectionFor(p);
    const header = named ? named[1] : `${section.toUpperCase()} ${p}`;
    cols.push({ version: 'v1.2', position: p, section, header, pinned: named ? !!named[2] : false });
  }
  return cols;
}

// Everything the seed writes: legacy v1.2 + active v2.0.
function buildAll() {
  return [...buildV12(), ...build()];
}

module.exports = { VERSION, LAST_POSITION, NAMED, build, buildV12, buildAll };
