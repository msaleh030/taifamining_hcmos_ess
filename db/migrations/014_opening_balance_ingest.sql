-- ===========================================================================
-- 014 — Opening-Balance & Document Ingestion (maker-checker, atomic, dry-run).
-- ===========================================================================
-- Loading opening balances and permits writes the numbers that determine what
-- people are owed. Same risk class as the Exact publish: validate → control-totals
-- → maker-checker → atomic. Staged in ingest_batch/ingest_row (preview writes
-- nothing live; submit stages; approve writes live). Additive; RLS per tenant.

-- OPENING BUCKET (carry-policy safety): opening balances land in leave_carry
-- tagged as a PROTECTED opening bucket, EXEMPT from the LR-4 lapse sweep until the
-- carry policy is decided. This lets us load now and apply the policy later
-- without re-lapsing. The lapse job (src/leave.js) must skip opening_bucket rows.
ALTER TABLE leave_carry ADD COLUMN IF NOT EXISTS opening_bucket boolean NOT NULL DEFAULT false;

-- A staged ingestion (opening_balance | permit). submitted_by = the maker; a
-- DIFFERENT committed_by = the checker (enforced at the endpoint). control holds
-- the caller's expected per-site totals; commit blocks if they don't reconcile.
CREATE TABLE IF NOT EXISTS ingest_batch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES tenant(company_id),
  kind          text NOT NULL CHECK (kind IN ('opening_balance','permit')),
  status        text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','committed','aborted')),
  submitted_by  uuid,
  committed_by  uuid,
  control       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- caller's expected per-site totals
  clean_count   int NOT NULL DEFAULT 0,
  exception_count int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  committed_at  timestamptz
);

-- One row per source line, with its normalised form, clean/exception status and
-- the blocking reasons (the exception report reads these).
CREATE TABLE IF NOT EXISTS ingest_row (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES tenant(company_id),
  batch_id         uuid NOT NULL REFERENCES ingest_batch(id) ON DELETE CASCADE,
  row_no           int  NOT NULL,
  pf               text,
  site_id          uuid,
  normalized       jsonb NOT NULL,
  status           text NOT NULL CHECK (status IN ('clean','exception')),
  exceptions       jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings         jsonb NOT NULL DEFAULT '[]'::jsonb,
  matched_employee uuid
);
CREATE INDEX IF NOT EXISTS ingest_row_batch_idx ON ingest_row (company_id, batch_id);

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['ingest_batch','ingest_row']) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON ingest_batch, ingest_row TO hcmos_app;
-- The ingest commit creates employees through the application's creation path
-- (src/employees.create), so the app role needs INSERT on employee. RLS still
-- scopes every row to the tenant; site_id is set so site-bound roles see them.
GRANT INSERT ON employee TO hcmos_app;
