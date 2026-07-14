-- ===========================================================================
-- 013 — F6: publish fan-out with PER-LEG status (GL post + ESS payslip push).
-- ===========================================================================
-- Publish flips the batch to published (atomic), then fans out to two legs:
--   • gl  — post the payroll journal to the general ledger;
--   • ess — push payslips to employee self-service.
-- A leg can fail independently ("GL posted, ESS push failed" is a real partial
-- state), so we track each leg's status and retry is SCOPED to non-posted legs.
-- The GL/ESS artifact tables are keyed one-per-batch, so a leg can be posted at
-- most once — a retry can never double-post to the ledger.

CREATE TABLE IF NOT EXISTS exact_publish_leg (
  company_id uuid NOT NULL REFERENCES tenant(company_id),
  batch_id   uuid NOT NULL REFERENCES exact_batch(id) ON DELETE CASCADE,
  leg        text NOT NULL CHECK (leg IN ('gl','ess')),
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','failed')),
  detail     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, batch_id, leg)
);

-- GL journal — exactly one posting per batch (double-post is structurally impossible).
CREATE TABLE IF NOT EXISTS gl_posting (
  company_id uuid NOT NULL REFERENCES tenant(company_id),
  batch_id   uuid NOT NULL REFERENCES exact_batch(id) ON DELETE CASCADE,
  net        numeric(16,2) NOT NULL,
  posted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, batch_id)
);

-- ESS payslip push — one push record per batch.
CREATE TABLE IF NOT EXISTS ess_push (
  company_id uuid NOT NULL REFERENCES tenant(company_id),
  batch_id   uuid NOT NULL REFERENCES exact_batch(id) ON DELETE CASCADE,
  pushed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, batch_id)
);

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['exact_publish_leg','gl_posting','ess_push']) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON exact_publish_leg TO hcmos_app;
GRANT SELECT, INSERT ON gl_posting, ess_push TO hcmos_app;
