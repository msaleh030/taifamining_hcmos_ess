-- ===========================================================================
-- 026 — Rich employee-master fields (six-site canonical model, Kira 2026-07-12)
-- ===========================================================================
-- The real master files carry more identity than 025 modelled. Tiering per
-- Kira: name/position/department/site/email/level/employment_type/reporting =
-- HR/directory-visible → columns on employee. dob/gender/passport/citizenship/
-- work-permit/nssf/personal-email/address/next-of-kin = PII → employee_pay
-- (the pay/PII-gated table; absent for non-permitted roles, never masked).
--
-- reporting_to is SPLIT (approved): reports_to_title is free text (what the
-- files actually carry); manager_id is a REAL employee reference set only when
-- a reporting_to_pf resolves to a loaded employee — no fabricated links.
-- Additive only.

SET client_min_messages = warning;

-- Directory-tier identity.
ALTER TABLE employee ADD COLUMN IF NOT EXISTS level            text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS employment_type  text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS reports_to_title text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS manager_id       uuid REFERENCES employee(id);
CREATE INDEX IF NOT EXISTS employee_manager_idx ON employee (company_id, manager_id);

-- PII tier (same table + same gate as pay/bank/tin — a3.pay.roles).
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS dob                  date;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS gender               text;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS bank_branch          text;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS account_name         text;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS passport_number      text;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS citizenship          text;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS work_permit_number   text;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS work_permit_validity date;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS nssf_number          text;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS personal_email       text;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS full_address         text;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS nok_relationship     text;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS nok_name             text;
ALTER TABLE employee_pay ADD COLUMN IF NOT EXISTS nok_contact          text;
