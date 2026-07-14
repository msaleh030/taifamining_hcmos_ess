-- ===========================================================================
-- 012 — F6: declared control totals on an Exact batch (publish safety net).
-- ===========================================================================
-- An Exact export carries control totals (the payroll summary the file must
-- reconcile to). We store the DECLARED totals at upload; publish recomputes the
-- sums from the staged rows and BLOCKS if they don't reconcile — a hard gate, not
-- a warning that can be clicked past. Columns are nullable (a batch without
-- declared totals simply has nothing to reconcile against). Additive; RLS already
-- isolates exact_batch by tenant.
ALTER TABLE exact_batch
  ADD COLUMN IF NOT EXISTS control_total_pay       numeric(16,2),
  ADD COLUMN IF NOT EXISTS control_total_deduction numeric(16,2),
  ADD COLUMN IF NOT EXISTS control_net             numeric(16,2);
