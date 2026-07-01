-- ===========================================================================
-- 008 — Slice 8: Exact payroll ingestion (confirmed column contract v1.2)
-- ===========================================================================
-- Uploads are validated against a VERSIONED column contract (the registry v1.2
-- appendix) — not hard-coded. A load stages rows; matching resolves EMPLOYEE ID
-- to an employee; publish is atomic. Additive; tenant tables isolated by RLS.

-- The column contract itself (reference data, shared across tenants, versioned).
CREATE TABLE IF NOT EXISTS exact_column (
  version  text NOT NULL,
  position int  NOT NULL,
  section  text NOT NULL,
  header   text NOT NULL,
  pinned   boolean NOT NULL DEFAULT false,  -- header text enforced on validation
  PRIMARY KEY (version, position)
);

-- A staged/published upload.
CREATE TABLE IF NOT EXISTS exact_batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES tenant(company_id),
  period       text,
  filename     text,
  file_hash    text NOT NULL,
  version      text NOT NULL,
  status       text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','published')),
  row_count    int  NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (company_id, file_hash)            -- idempotent re-load
);

-- One row per data line, with the full cell array kept for later reconciliation.
CREATE TABLE IF NOT EXISTS exact_row (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES tenant(company_id),
  batch_id         uuid NOT NULL REFERENCES exact_batch(id) ON DELETE CASCADE,
  row_no           int  NOT NULL,
  employee_id_raw  text,
  full_name        text,
  cells            jsonb NOT NULL,
  matched_employee uuid REFERENCES employee(id) ON DELETE SET NULL,
  match_status     text NOT NULL DEFAULT 'pending' CHECK (match_status IN ('pending','matched','unmatched'))
);

CREATE INDEX IF NOT EXISTS exact_row_batch_idx ON exact_row (company_id, batch_id);

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['exact_batch','exact_row']) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP;
END $$;

GRANT SELECT ON exact_column TO hcmos_app;
GRANT SELECT, INSERT, UPDATE ON exact_batch, exact_row TO hcmos_app;
