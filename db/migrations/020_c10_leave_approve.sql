-- ===========================================================================
-- 020 — C10 leave approve + coverage (Kira's build order, 2026-07-06):
--       approval queue + decision (LV-03), SOD-01 maker≠checker, LR-6
--       coverage warn-not-block with the UNI-06 audited override.
-- ===========================================================================
-- Additive only. from/to dates carry the request window the LR-6 coverage
-- meter computes over (E4 drew dates; the endpoint took day counts — days
-- stays authoritative for balance math, the window is for coverage/overlap).
ALTER TABLE leave_request ADD COLUMN IF NOT EXISTS from_date date;
ALTER TABLE leave_request ADD COLUMN IF NOT EXISTS to_date date;
ALTER TABLE leave_request DROP CONSTRAINT IF EXISTS leave_request_window_check;
ALTER TABLE leave_request ADD CONSTRAINT leave_request_window_check
  CHECK (from_date IS NULL OR (to_date IS NOT NULL AND to_date >= from_date));

-- Decision trail (who/when/why) + the LR-6 acknowledged-override marker.
ALTER TABLE leave_request ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES app_user(id);
ALTER TABLE leave_request ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE leave_request ADD COLUMN IF NOT EXISTS decision_note text;
ALTER TABLE leave_request ADD COLUMN IF NOT EXISTS coverage_override boolean NOT NULL DEFAULT false;
