-- ===========================================================================
-- 005 — Leave carry-forward ledger (supports LR-4 nightly lapse)
-- ===========================================================================
-- Minimal structure to support the LR-4 rule: carried-forward leave lapses after
-- a configurable number of years (registry: leave.carry.lapse_years; value = 1,
-- pinned by test/leave.test.js — not by this comment).
-- A nightly job (src/leave.js) marks expired carry as lapsed. Entitlement/accrual
-- (LR-1) is out of scope here; this table only records carry and its lapse state.
-- Additive — no data dropped. Tenant-isolated by RLS like every other table.

CREATE TABLE IF NOT EXISTS leave_carry (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES tenant(company_id),
  employee_id     uuid NOT NULL REFERENCES employee(id),
  days            numeric(5,1) NOT NULL CHECK (days >= 0),
  carried_for_year integer NOT NULL,   -- calendar year the unused entitlement came from
  created_at      timestamptz NOT NULL DEFAULT now(),
  lapsed_at       timestamptz          -- set by the nightly lapse job when expired
);

CREATE INDEX IF NOT EXISTS leave_carry_open_idx
  ON leave_carry (company_id, carried_for_year) WHERE lapsed_at IS NULL;

ALTER TABLE leave_carry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON leave_carry;
CREATE POLICY tenant_isolation ON leave_carry
  USING (company_id = current_company()) WITH CHECK (company_id = current_company());

GRANT SELECT, INSERT, UPDATE ON leave_carry TO hcmos_app;
