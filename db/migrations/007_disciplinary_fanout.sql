-- ===========================================================================
-- 007 — Slice 4: Disciplinary action + atomic fan-out (C8)
-- ===========================================================================
-- A single confirmed disciplinary action fans out (register entry, ESS + console
-- notifications, auto warning letter, activity feed, audit) inside ONE
-- transaction — the application does the fan-out within withTenant, so any
-- failure rolls the whole thing back. This migration adds the durable structures.
-- Additive; RLS isolates every new table by tenant.

-- Line manager per site (resolved into disciplinary notifications + audit).
-- ON DELETE SET NULL so a re-seed can delete employees without ordering games.
ALTER TABLE site ADD COLUMN IF NOT EXISTS manager_employee_id uuid
  REFERENCES employee(id) ON DELETE SET NULL;

-- Disciplinary register — extend the Slice-2 table with the action taxonomy,
-- issuer/approver (SoD), and the resolved manager captured at issue time.
ALTER TABLE disciplinary ADD COLUMN IF NOT EXISTS action_type text
  CHECK (action_type IN ('verbal','written','final','suspension'));
ALTER TABLE disciplinary ADD COLUMN IF NOT EXISTS issuer_role   text;
ALTER TABLE disciplinary ADD COLUMN IF NOT EXISTS approver      text;
ALTER TABLE disciplinary ADD COLUMN IF NOT EXISTS approver_role text;
ALTER TABLE disciplinary ADD COLUMN IF NOT EXISTS manager_employee_id uuid
  REFERENCES employee(id) ON DELETE SET NULL;
ALTER TABLE disciplinary ADD COLUMN IF NOT EXISTS manager_name  text;

-- The auto-generated warning letter lands in My Documents — allow its kind.
ALTER TABLE employee_document DROP CONSTRAINT IF EXISTS employee_document_kind_check;
ALTER TABLE employee_document ADD CONSTRAINT employee_document_kind_check
  CHECK (kind IN ('contract','medical','permit','warning','other'));

-- Notifications: ESS (to the employee) and console (to line manager + HR).
CREATE TABLE IF NOT EXISTS notification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES tenant(company_id),
  employee_id uuid NOT NULL REFERENCES employee(id),   -- subject
  audience    text NOT NULL CHECK (audience IN ('ess','console')),
  recipient   text,
  kind        text NOT NULL,
  body        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Activity feed entries.
CREATE TABLE IF NOT EXISTS activity_feed (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES tenant(company_id),
  employee_id uuid NOT NULL REFERENCES employee(id),
  actor       text,
  kind        text NOT NULL,
  summary     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_emp_idx  ON notification (company_id, employee_id);
CREATE INDEX IF NOT EXISTS activity_feed_emp_idx ON activity_feed (company_id, employee_id);

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['notification','activity_feed']) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP;
END $$;

-- Grants — the fan-out runs under the app role inside withTenant (RLS-checked).
GRANT INSERT ON disciplinary, employee_document TO hcmos_app;
GRANT SELECT, INSERT ON notification, activity_feed TO hcmos_app;
-- Suspension flips the subject's login state app-wide; only the status column.
GRANT UPDATE (status) ON app_user TO hcmos_app;
