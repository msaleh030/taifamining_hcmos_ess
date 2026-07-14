-- HCMOS ESS — Slice 2: Employee Master (Directory + Profile)
-- Implements AC-EMP-01..03, AC-UNI-02/04/05/06. Builds on Slice 1; additive.
--
-- Design centre of gravity (C5): a confidential field a role may not see is
-- ABSENT from the JSON — never masked, never null-with-a-flag. To make that the
-- default at the data layer, confidential data lives in SEPARATE tables
-- (employee_pay / employee_medical / disciplinary): a non-permitted role's read
-- simply does not perform the join, so the key cannot appear.

SET client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- Reference / config tables
-- ---------------------------------------------------------------------------

-- Sites (tenant-scoped). Employees belong to a site; some roles are site-scoped.
CREATE TABLE IF NOT EXISTS site (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES tenant(company_id),
  name       text NOT NULL
);

-- Which roles are restricted to their own site. Global role config (no tenant
-- column, no RLS) — data/config, NOT hard-coded in application logic.
CREATE TABLE IF NOT EXISTS site_scope (
  role_code text PRIMARY KEY,
  scoped    boolean NOT NULL
);

-- ---------------------------------------------------------------------------
-- Employee reshape — emp_no is permanent (survives transfer/rehire; Slice MOV)
-- ---------------------------------------------------------------------------
ALTER TABLE employee ADD COLUMN IF NOT EXISTS emp_no       text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS role_code    text
  CHECK (role_code IN ('R01','R02','R03','R04','R05','R06','R07','R08','R09','R10','R11','R12','R13'));
ALTER TABLE employee ADD COLUMN IF NOT EXISTS site_id      uuid REFERENCES site(id);
ALTER TABLE employee ADD COLUMN IF NOT EXISTS dept         text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS status       text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','suspended','terminated','rehire'));
ALTER TABLE employee ADD COLUMN IF NOT EXISTS phone        text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS email        text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS home_address text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS joined_at    date;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS created_at   timestamptz NOT NULL DEFAULT now();

-- Slice 1 stored confidential data as columns on employee. Slice 2 normalises
-- them into separate, independently-authorised tables — drop the placeholders.
ALTER TABLE employee DROP COLUMN IF EXISTS pay_grade;
ALTER TABLE employee DROP COLUMN IF EXISTS bank_account;
ALTER TABLE employee DROP COLUMN IF EXISTS medical_notes;
ALTER TABLE employee DROP COLUMN IF EXISTS permits;
ALTER TABLE employee DROP COLUMN IF EXISTS disciplinary;

-- emp_no unique per company (only where assigned).
CREATE UNIQUE INDEX IF NOT EXISTS employee_empno_key
  ON employee (company_id, emp_no) WHERE emp_no IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Confidential tables (separate, so a forbidden read is "no row", not a mask)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_pay (
  employee_id  uuid PRIMARY KEY REFERENCES employee(id),
  company_id   uuid NOT NULL REFERENCES tenant(company_id),
  basic_pay    numeric(14,2),
  bank_name    text,
  bank_account text
);

CREATE TABLE IF NOT EXISTS employee_medical (
  employee_id   uuid PRIMARY KEY REFERENCES employee(id),
  company_id    uuid NOT NULL REFERENCES tenant(company_id),
  osha_status   text,
  permit_no     text,
  permit_expiry date
);

CREATE TABLE IF NOT EXISTS disciplinary (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES tenant(company_id),
  employee_id uuid NOT NULL REFERENCES employee(id),
  kind        text,
  detail      text,
  issued_by   text,
  issued_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Documents & assets (register/assign/track)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_document (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES tenant(company_id),
  employee_id uuid NOT NULL REFERENCES employee(id),
  kind        text NOT NULL CHECK (kind IN ('contract','medical','permit','other')),
  name        text NOT NULL,
  valid_until date,
  uri         text
);

CREATE TABLE IF NOT EXISTS employee_asset (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES tenant(company_id),
  employee_id uuid NOT NULL REFERENCES employee(id),
  name        text NOT NULL,
  serial      text,
  status      text NOT NULL DEFAULT 'assigned'
);

-- ---------------------------------------------------------------------------
-- Maker-checker queue (EMP-03 / SOD-03)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field_change (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES tenant(company_id),
  employee_id uuid NOT NULL REFERENCES employee(id),
  field       text NOT NULL,
  before      text,
  after       text,
  maker       text NOT NULL,
  maker_role  text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  checker     text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- RLS — every new tenant-scoped table (site_scope is global config, excluded)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
      'site','employee_pay','employee_medical','disciplinary',
      'employee_document','employee_asset','field_change'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Indexes for the directory at scale (2,000 → 10,000+ employees)
-- Keyset pagination orders by (full_name, id); filters by site/status/dept;
-- search uses pg_trgm for indexed substring matching.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS employee_company_name_idx   ON employee (company_id, full_name, id);
CREATE INDEX IF NOT EXISTS employee_company_site_idx    ON employee (company_id, site_id);
CREATE INDEX IF NOT EXISTS employee_company_status_idx  ON employee (company_id, status);
CREATE INDEX IF NOT EXISTS employee_company_dept_idx    ON employee (company_id, dept);
CREATE INDEX IF NOT EXISTS employee_fullname_trgm_idx   ON employee USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS employee_empno_trgm_idx      ON employee USING gin (emp_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS field_change_status_idx      ON field_change (company_id, status);
CREATE INDEX IF NOT EXISTS field_change_emp_idx         ON field_change (company_id, employee_id);

-- ---------------------------------------------------------------------------
-- Grants — Slice 2 introduces within-tenant writes. Because every authenticated
-- request runs with app.company_id pinned from the verified session, these run
-- under RLS (USING + WITH CHECK), so tenant isolation holds without a function
-- per mutation. Confidential reads are gated in the application by the A3 map.
-- ---------------------------------------------------------------------------
GRANT SELECT ON site, site_scope, employee_pay, employee_medical, disciplinary,
                employee_document, employee_asset, field_change TO hcmos_app;
-- maker submits, checker decides
GRANT INSERT, UPDATE ON field_change TO hcmos_app;
-- approved field_change applies to the employee row (within-tenant, RLS-checked)
GRANT UPDATE ON employee TO hcmos_app;
