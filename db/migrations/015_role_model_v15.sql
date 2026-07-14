-- ===========================================================================
-- 015 — Registry v1.5 role-model change (LI-2 / LI-4): +R14 CEO/Executive.
-- ===========================================================================
-- Widens the role_code CHECK constraints to accept R14 (CEO/Executive, read-only
-- org-wide oversight). R10 (Clinic/Medical Staff) is RETIRED at the APPLICATION
-- layer (no landing, no modules, no A3 field rules — an R10 session holds
-- nothing); it stays valid at the DB layer so historical rows are not orphaned
-- by a constraint change (non-destructive migration principle). Migrate any
-- remaining R10 rows to R03 (HR Officer absorbs clinic/medical), then a future
-- migration may drop R10 from the constraint once data is confirmed clean.

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_role_code_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_role_code_check
  CHECK (role_code IN ('R01','R02','R03','R04','R05','R06','R07',
                       'R08','R09','R10','R11','R12','R13','R14'));

ALTER TABLE employee DROP CONSTRAINT IF EXISTS employee_role_code_check;
ALTER TABLE employee ADD CONSTRAINT employee_role_code_check
  CHECK (role_code IN ('R01','R02','R03','R04','R05','R06','R07',
                       'R08','R09','R10','R11','R12','R13','R14'));

-- Data reconciliation (LI-2): any live R10 users/employees become HR Officers.
-- No-ops on a fresh seed (nothing is R10 any more).
UPDATE app_user SET role_code = 'R03' WHERE role_code = 'R10';
UPDATE employee SET role_code = 'R03' WHERE role_code = 'R10';
