-- ===========================================================================
-- 017 — Registry v1.5 LR-4/LR-8/LR-9: going-forward carry rule.
-- ===========================================================================
-- REPLACES the flat one-year lapse. At each employee's EMPLOYMENT ANNIVERSARY
-- carried-forward annual leave is capped at leave.carry.cap_days (excess
-- forfeited); at anniversary + leave.carry.grace_months any carried days still
-- unused are forfeited. The opening bucket (opening_bucket=true) is EXEMPT and
-- never touched (OB-5). The sweep is daily and IDEMPOTENT: this ledger records
-- one row per (employee, anniversary cycle, phase), so a re-run cannot forfeit
-- twice. Every forfeiture also writes an audit-chain row.

CREATE TABLE IF NOT EXISTS leave_carry_sweep (
  company_id     uuid NOT NULL REFERENCES tenant(company_id),
  employee_id    uuid NOT NULL REFERENCES employee(id),
  cycle_year     int  NOT NULL,             -- year of the anniversary processed
  phase          text NOT NULL CHECK (phase IN ('cap','forfeit')),
  days_forfeited numeric(6,1) NOT NULL,
  applied_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, employee_id, cycle_year, phase)
);

ALTER TABLE leave_carry_sweep ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON leave_carry_sweep;
CREATE POLICY tenant_isolation ON leave_carry_sweep
  USING (company_id = current_company()) WITH CHECK (company_id = current_company());

GRANT SELECT, INSERT ON leave_carry_sweep TO hcmos_app;
