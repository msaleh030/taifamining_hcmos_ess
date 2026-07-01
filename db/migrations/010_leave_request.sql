-- ===========================================================================
-- 010 — F3: Leave requests (apply + balance). Sick draws a SEPARATE bucket.
-- ===========================================================================
-- Annual and sick are distinct leave types so sick never draws from annual
-- (LR-7). Balances are computed from entitlement (LR-1) + carry (LR-4, the
-- leave_carry ledger) minus taken. Additive; RLS-isolated per tenant.

CREATE TABLE IF NOT EXISTS leave_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES tenant(company_id),
  employee_id  uuid NOT NULL REFERENCES employee(id),
  leave_type   text NOT NULL CHECK (leave_type IN ('annual','sick')),
  days         numeric(5,1) NOT NULL CHECK (days > 0),
  status       text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','approved','declined','cancelled')),
  hoh_override boolean NOT NULL DEFAULT false,
  applied_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leave_request_emp_idx ON leave_request (company_id, employee_id, leave_type);

ALTER TABLE leave_request ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON leave_request;
CREATE POLICY tenant_isolation ON leave_request
  USING (company_id = current_company()) WITH CHECK (company_id = current_company());

GRANT SELECT, INSERT, UPDATE ON leave_request TO hcmos_app;
