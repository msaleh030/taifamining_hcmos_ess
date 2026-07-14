-- 041 — ESS-5: offline sync-conflict resolution (UNI-01 queue → UNI-06 audit).
-- The reference names ONE conflict kind: "Duplicate clock-in — two open punches
-- with no clock-out between them." Resolution is keep-device / keep-server /
-- keep-both, decided by the worker on the phone, audited, server stays the
-- source of truth.
--   • superseded_by: keep-device replaces the server punch — the loser row is
--     never deleted (append-only discipline), it points at the winner.
--   • review_flag: keep-both records BOTH punches and flags them for the
--     timekeeper ("Keep both · flag for timekeeper").
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES attendance(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS review_flag text;

-- Conflict detection scans "the latest live punch today" per employee.
CREATE INDEX IF NOT EXISTS attendance_emp_live_idx
  ON attendance (employee_id, punched_at DESC) WHERE superseded_by IS NULL;
