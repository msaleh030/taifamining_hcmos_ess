-- ===========================================================================
-- 028 — PF uniqueness is SITE-LEVEL (Kira ruling, 2026-07-12) + payroll fields
-- ===========================================================================
-- Kira: "Cross-site duplicate PFs are legitimate. Within a site, a PF must
-- still be unique." The tenant-wide unique index on legacy_id (004) blocked
-- the 19 legitimate cross-site duplicates; it becomes (company, SITE, pf).
-- emp_no (TMCL scheme / PF-as-number) stays company-unique — a cross-site
-- duplicate PF loads with emp_no left NULL and the row flagged, so the number
-- scheme's integrity is never silently weakened.
DROP INDEX IF EXISTS employee_legacy_key;
CREATE UNIQUE INDEX IF NOT EXISTS employee_legacy_site_key
  ON employee (company_id, site_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- Payroll master (behind the pay-visibility gate, same table the A3 pay tier
-- reads): monthly basic/gross in the file's currency. Loaded ONLY through the
-- maker-checker payroll_master ingest — never a raw INSERT.
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS basic_salary numeric(14,2);
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS gross_salary numeric(14,2);
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS pay_currency text;

-- Fourth ingest kind: the payroll master (maker-checker, pay-gated).
ALTER TABLE ingest_batch DROP CONSTRAINT IF EXISTS ingest_batch_kind_check;
ALTER TABLE ingest_batch ADD  CONSTRAINT ingest_batch_kind_check
  CHECK (kind IN ('opening_balance','permit','employee_master','payroll_master'));
