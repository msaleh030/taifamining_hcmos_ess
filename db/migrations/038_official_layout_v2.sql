-- ===========================================================================
-- 038 — Contract v2.0: the OFFICIAL Exact export layout (Correction 1,
--       Kira 2026-07-14; header-map probe run 29331947385)
-- ===========================================================================
-- Correction 1 made the matcher HARD-FAIL when a configured pay-component name
-- resolves to zero or several contract columns — and that exposed the real
-- defect: the v1.2 registry-appendix grid (50 columns, title band, headers on
-- row 7) NEVER matched the official export. The export, read position by
-- position off the UAT box, is 49 columns with headers on ROW 1: allowances at
-- 9..26, 'Total Allowances' (GROSS) at 27, 'Cent Round Up' at 28, deductions
-- at 29..41, 'Total Deductions' at 42, 'Cent Round Down' at 43, 'Net Payment'
-- at 44, employer contributions at 45..48. Every ratified include/exclude/
-- pending name resolves to EXACTLY ONE of these columns; the two cent columns
-- close the ex-[TBC] round-up/round-down positions with evidence.
-- v1.2 rows stay untouched (historical batches read their contract by batch
-- version); nothing new validates against v1.2.
INSERT INTO exact_column (version, position, section, header, pinned) VALUES
  ('v2.0',  0, 'identity', 'Employee ID', true),
  ('v2.0',  1, 'identity', 'Full Name', true),
  ('v2.0',  2, 'identity', 'Current Position', true),
  ('v2.0',  3, 'identity', 'Employment Date', true),
  ('v2.0',  4, 'identity', 'Department Name', true),
  ('v2.0',  5, 'identity', 'Bank Name', true),
  ('v2.0',  6, 'identity', 'National ID Number', true),
  ('v2.0',  7, 'identity', 'TIN', true),
  ('v2.0',  8, 'identity', 'NSSF Number', true),
  ('v2.0',  9, 'allowances', 'Terminal Dues', true),
  ('v2.0', 10, 'allowances', 'Basic Salary', true),
  ('v2.0', 11, 'allowances', 'Gross Salary Arrears', true),
  ('v2.0', 12, 'allowances', 'Fixed Overtime', true),
  ('v2.0', 13, 'allowances', 'Project Allowance', true),
  ('v2.0', 14, 'allowances', 'Responsibility Allowance', true),
  ('v2.0', 15, 'allowances', 'Overtime - Normal Days', true),
  ('v2.0', 16, 'allowances', 'Transport Allowance(variable)', true),
  ('v2.0', 17, 'allowances', 'House Allowance(Variable)', true),
  ('v2.0', 18, 'allowances', 'Housing Allowance (Fixed)', true),
  ('v2.0', 19, 'allowances', 'Transport Allowance(Fixed)', true),
  ('v2.0', 20, 'allowances', 'TSF Allowance', true),
  ('v2.0', 21, 'allowances', 'Overtime - Holidays', true),
  ('v2.0', 22, 'allowances', 'Rotation Allowance', true),
  ('v2.0', 23, 'allowances', 'Local Conveyance', true),
  ('v2.0', 24, 'allowances', 'Night Allowance', true),
  ('v2.0', 25, 'allowances', 'Previous Cent-Round Deduction', true),
  ('v2.0', 26, 'allowances', 'Overdraft', true),
  ('v2.0', 27, 'totals', 'Total Allowances', true),
  ('v2.0', 28, 'rounding', 'Cent Round Up', true),
  ('v2.0', 29, 'deductions', 'Due on Termination', true),
  ('v2.0', 30, 'deductions', 'PAYE', true),
  ('v2.0', 31, 'deductions', 'Mid-Month Advance', true),
  ('v2.0', 32, 'deductions', 'NSSF Employee Contribution', true),
  ('v2.0', 33, 'deductions', 'Workers Welfare Union', true),
  ('v2.0', 34, 'deductions', 'Advance 2', true),
  ('v2.0', 35, 'deductions', 'Absent Deduction', true),
  ('v2.0', 36, 'deductions', 'ABSA Loan Repayment', true),
  ('v2.0', 37, 'deductions', 'HESLB 15%', true),
  ('v2.0', 38, 'deductions', 'Condolence Advance / Ndalo', true),
  ('v2.0', 39, 'deductions', 'M-Donation', true),
  ('v2.0', 40, 'deductions', 'NUMET', true),
  ('v2.0', 41, 'deductions', 'Previous Cent-Round Payment', true),
  ('v2.0', 42, 'totals', 'Total Deductions', true),
  ('v2.0', 43, 'rounding', 'Cent Round Down', true),
  ('v2.0', 44, 'net', 'Net Payment', true),
  ('v2.0', 45, 'employer', 'NSSF Employer Contribution', true),
  ('v2.0', 46, 'employer', 'NHIF Employer Contribution - Contribution Section', true),
  ('v2.0', 47, 'employer', 'Skills and Development Levy', true),
  ('v2.0', 48, 'employer', 'Workers Compensation Fund', true)
ON CONFLICT (version, position) DO UPDATE
  SET section = EXCLUDED.section, header = EXCLUDED.header, pinned = EXCLUDED.pinned;

-- Config rulings (upsert-overwrite — a stale tenant value cannot survive).
INSERT INTO config (company_id, key, value)
SELECT company_id, k, v FROM tenant, (VALUES
  ('exact.contract.version', 'v2.0'),
  ('exact.header_row',       '1'),
  ('exact.section_row',      '1'),
  ('exact.col.gross',        '27'),
  ('exact.col.roundup',      '28'),   -- 'Cent Round Up' — evidenced, ex-[TBC]
  ('exact.col.rounddown',    '43'),   -- 'Cent Round Down' — evidenced, ex-[TBC]
  ('exact.dailyrate.gross_name', 'Total Allowances')
) AS cfg(k, v)
ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value;
