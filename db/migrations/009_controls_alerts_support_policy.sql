-- ===========================================================================
-- 009 — Slice 9: Controls & Checker, expiry alerts, support tickets, policies
-- ===========================================================================
-- Module bodies wired onto the existing SoD/maker-checker, audit-chain and DA-1
-- lead-time engines. Additive; every tenant table isolated by RLS.

-- Attendance punches (evidence for the controls check; base for a later module).
CREATE TABLE IF NOT EXISTS attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES tenant(company_id),
  employee_id uuid NOT NULL REFERENCES employee(id),
  punched_at  timestamptz NOT NULL DEFAULT now(),
  lat         double precision,
  lng         double precision,
  accuracy    double precision,
  zone        text,          -- matched geofence zone; NULL = no location evidence
  source      text
);

-- Document expiry alerts (DA-1/DA-2), stateful: raised, repeated, cleared.
CREATE TABLE IF NOT EXISTS doc_alert (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES tenant(company_id),
  document_id      uuid NOT NULL REFERENCES employee_document(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  due_date         date NOT NULL,
  lead_days        int  NOT NULL,
  notify_role      text,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared')),
  notify_count     int  NOT NULL DEFAULT 0,
  raised_at        timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  cleared_at       timestamptz,
  UNIQUE (company_id, document_id)
);

-- Support tickets (E12) with a simple lifecycle.
CREATE TABLE IF NOT EXISTS support_ticket (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES tenant(company_id),
  employee_id uuid NOT NULL REFERENCES employee(id),
  subject     text NOT NULL,
  body        text,
  channel     text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Policies (versioned) + acknowledgements (E7).
CREATE TABLE IF NOT EXISTS policy (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES tenant(company_id),
  code         text NOT NULL,
  version      int  NOT NULL,
  title        text NOT NULL,
  body         text,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code, version)
);
CREATE TABLE IF NOT EXISTS policy_ack (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES tenant(company_id),
  policy_code     text NOT NULL,
  version         int  NOT NULL,
  employee_id     uuid NOT NULL REFERENCES employee(id),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, policy_code, version, employee_id)
);

CREATE INDEX IF NOT EXISTS attendance_emp_idx     ON attendance (company_id, employee_id);
CREATE INDEX IF NOT EXISTS support_ticket_emp_idx ON support_ticket (company_id, employee_id);
CREATE INDEX IF NOT EXISTS policy_code_idx        ON policy (company_id, code, version);
CREATE INDEX IF NOT EXISTS policy_ack_idx         ON policy_ack (company_id, policy_code, version);

-- DA-1 covers licences too — allow the kind.
ALTER TABLE employee_document DROP CONSTRAINT IF EXISTS employee_document_kind_check;
ALTER TABLE employee_document ADD CONSTRAINT employee_document_kind_check
  CHECK (kind IN ('contract','medical','permit','licence','warning','other'));

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['attendance','doc_alert','support_ticket','policy','policy_ack']) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON attendance, doc_alert, support_ticket, policy, policy_ack TO hcmos_app;
