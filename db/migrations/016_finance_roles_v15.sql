-- ===========================================================================
-- 016 — Registry v1.5 LI-3/LI-6: finance restructure (+R15 Finance Manager,
--       +R16 Chief Financial Controller; R08/R09 retired).
-- ===========================================================================
-- Widens the role_code CHECKs to accept R15/R16. R08 (Finance Officer) and R09
-- (Payroll Manager) are RETIRED at the application layer (no landing, no pay
-- visibility, no actions) but stay valid at the DB layer so historical rows are
-- not orphaned (non-destructive principle, same as R10 in 015). Live R08/R09
-- rows are migrated to R15 (Finance Manager absorbs both remits); the CFC (R16)
-- is an APPOINTED senior role — nobody is auto-migrated into it.

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_role_code_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_role_code_check
  CHECK (role_code IN ('R01','R02','R03','R04','R05','R06','R07','R08',
                       'R09','R10','R11','R12','R13','R14','R15','R16'));

ALTER TABLE employee DROP CONSTRAINT IF EXISTS employee_role_code_check;
ALTER TABLE employee ADD CONSTRAINT employee_role_code_check
  CHECK (role_code IN ('R01','R02','R03','R04','R05','R06','R07','R08',
                       'R09','R10','R11','R12','R13','R14','R15','R16'));

-- Data reconciliation (LI-3): live finance users/employees become Finance
-- Managers. No-ops on a fresh seed. Confirm at the UAT design reconciliation.
UPDATE app_user SET role_code = 'R15' WHERE role_code IN ('R08', 'R09');
UPDATE employee SET role_code = 'R15' WHERE role_code IN ('R08', 'R09');
