-- ===========================================================================
-- 019 — DA-2 three-way routing (Kira, ratified 2026-07-06):
--       expat/immigration permit expiries → Head of HR (R11) ONLY (sensitive —
--       visibility AND notification); other business licence/permit expiries →
--       SHEQ Manager (R06, unchanged); medical-document expiries → the HR
--       Officer (R03) FOR THE EMPLOYEE'S SITE (not all HR Officers).
-- ===========================================================================
-- The expat-vs-business distinction did not exist in the schema; this adds it
-- as an explicit field. EXISTING 'permit' rows are NOT classified here — the
-- classification is a client fact, never guessed (Kira's instruction). NULL
-- permit_type FAILS CLOSED: routed and visible as the sensitive leg (R11 only)
-- and flagged `unclassified` until someone who knows classifies the row.
ALTER TABLE employee_document ADD COLUMN IF NOT EXISTS permit_type text;
ALTER TABLE employee_document DROP CONSTRAINT IF EXISTS employee_document_permit_type_check;
ALTER TABLE employee_document ADD CONSTRAINT employee_document_permit_type_check
  CHECK (permit_type IS NULL OR (kind = 'permit' AND permit_type IN ('expat','business')));

-- Site-matched routing target for medical alerts (the subject employee's site)
-- and the fail-closed flag for unclassified permits.
ALTER TABLE doc_alert ADD COLUMN IF NOT EXISTS notify_site uuid REFERENCES site(id);
ALTER TABLE doc_alert ADD COLUMN IF NOT EXISTS unclassified boolean NOT NULL DEFAULT false;
