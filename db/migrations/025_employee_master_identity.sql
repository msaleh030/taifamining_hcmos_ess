-- ===========================================================================
-- 025 — Employee-master identity fields (populate the directory from the real
--       North Mara master file: 285 employees, identity columns only)
-- ===========================================================================
-- The directory/leave/overview screens read the `employee` table. Loading the
-- real master brings Omid's (R11) directory to life. This migration adds the two
-- identity fields the master carries that the schema did not yet model, keeping
-- the Slice-2 confidentiality centre of gravity (C5): a field a role may not see
-- is ABSENT (it lives in a separately-authorised table), never masked.
--
--   • position  — job title. DIRECTORY-VISIBLE (name / position / department /
--                 site are the only directory-visible identity fields), so it is
--                 a plain column on `employee`.
--   • national_id + tin — government identity numbers. CONFIDENTIAL: they live in
--                 employee_pay, behind the SAME pay-visibility gate as pay/bank
--                 data (a3.pay.roles), so a non-permitted read never joins them
--                 and the key cannot appear. `bank` reuses employee_pay.bank_name.
--
-- Additive only; no data dropped.

SET client_min_messages = warning;

-- Directory-visible job title.
ALTER TABLE employee ADD COLUMN IF NOT EXISTS position text;

-- Confidential identity numbers — same table + same gate as bank/pay data.
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS national_id text;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS tin         text;

-- Directory filters/searches sometimes narrow by position; index it like dept.
CREATE INDEX IF NOT EXISTS employee_company_position_idx ON employee (company_id, position);

-- The ingest batch now carries a third kind: the employee-master load runs
-- through the SAME maker-checker / control-totals / atomic discipline.
ALTER TABLE ingest_batch DROP CONSTRAINT IF EXISTS ingest_batch_kind_check;
ALTER TABLE ingest_batch ADD  CONSTRAINT ingest_batch_kind_check
  CHECK (kind IN ('opening_balance','permit','employee_master'));

-- The master load writes the confidential identity (bank / national_id / tin)
-- into employee_pay under RLS (company_id pinned from the verified session).
-- Slice 2 granted only SELECT; the audited ingest now needs INSERT/UPDATE.
GRANT INSERT, UPDATE ON employee_pay TO hcmos_app;
