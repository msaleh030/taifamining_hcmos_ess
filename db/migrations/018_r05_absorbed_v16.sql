-- ===========================================================================
-- 018 — Registry v1.6 (Kira, ratified): HSE Officer (R05) absorbed by the
--       SHEQ Manager (R06, the post is Maurice's). R11 renamed to 'Head of HR'
--       (name lives in src/roles.js — no DB change needed for the rename).
-- ===========================================================================
-- R05 is RETIRED at the application layer (no landing, dropped from the
-- medical/permits/disciplinary field rules and the issuer/alerts/notify role
-- sets) but stays valid at the DB layer so historical rows are not orphaned
-- (non-destructive principle, same as R10 in 015 and R08/R09 in 016). The
-- role_code CHECKs already include R05 — no constraint change required.

-- Data reconciliation: live HSE Officer users/employees become SHEQ Manager.
-- No-ops on a fresh seed. Confirm at the UAT design reconciliation.
UPDATE app_user SET role_code = 'R06' WHERE role_code = 'R05';
UPDATE employee SET role_code = 'R06' WHERE role_code = 'R05';
