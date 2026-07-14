-- ===========================================================================
-- 043 — REHIRE ruling (Kira 2026-07-14, MOV-02).
-- ===========================================================================
-- a. SAME TMCL: a rehired person recovers their ORIGINAL number — the same
--    employee row reactivates; the number never re-mints.
-- b. SERVICE CONTINUITY IS NOT A FIXED RULE: bridge-or-reset is a PER-REHIRE
--    DECISION the Head of HR (R11) records ON the rehire, WITH A REASON, and
--    it is audited. No silent default — the flow refuses without the choice.
--    It anchors leave accrual (employee.joined_at) and every future
--    service-based calculation from that point. Omid rules each case; the
--    system records and audits, never assumes.
CREATE TABLE IF NOT EXISTS employee_rehire (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES tenant(company_id),
  employee_id  uuid NOT NULL REFERENCES employee(id),
  rehired_at   date NOT NULL,
  continuity   text NOT NULL CHECK (continuity IN ('bridge','reset')),
  reason       text NOT NULL CHECK (length(trim(reason)) > 0),
  decided_by   uuid NOT NULL REFERENCES app_user(id),
  prev_joined_at date,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_rehire_emp_idx ON employee_rehire (company_id, employee_id);

ALTER TABLE employee_rehire ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee_rehire;
CREATE POLICY tenant_isolation ON employee_rehire
  USING (company_id = current_company()) WITH CHECK (company_id = current_company());

GRANT SELECT, INSERT ON employee_rehire TO hcmos_app;
