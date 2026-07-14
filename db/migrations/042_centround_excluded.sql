-- 042 — Kira ruling 2026-07-14: cent-round columns EXCLUDED from the leave-pay
-- base. "It is a rounding carry, not earned pay." Applies to ALL cent-round
-- columns, byte-identical contract headers:
--   25 Previous Cent-Round Deduction (allowances band — was the last
--      unclassified allowance column; money there no longer auto-blocks),
--   28 Cent Round Up, 43 Cent Round Down (rounding band),
--   41 Previous Cent-Round Payment (deductions band).
-- They live in the Net formula (Net = Total Allowances − Total Deductions
-- + Cent Round Up − Cent Round Down), never the base.
-- STILL PENDING CECILIA (gate stays closed): Local Conveyance (23),
-- TSF Allowance (20). Ruling — upsert-overwrite, a stale value cannot survive.
INSERT INTO config (company_id, key, value)
SELECT company_id, 'exact.dailyrate.exclude_names',
       'Rotation Allowance,Night Allowance,Overtime - Normal Days,Overtime - Holidays,Transport Allowance(variable),House Allowance(Variable),Gross Salary Arrears,Terminal Dues,Overdraft,Previous Cent-Round Deduction,Cent Round Up,Cent Round Down,Previous Cent-Round Payment'
  FROM tenant
ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value;
