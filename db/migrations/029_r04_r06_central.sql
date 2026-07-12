-- ===========================================================================
-- 029 — R04 (HR Manager) + R06 (SHEQ Manager) are CENTRAL (Kira, 2026-07-12)
-- ===========================================================================
-- The confirmed user-account matrix scopes every R04 and the R06 as
-- "All sites": org-wide roles, not site-bound. The site gate keeps applying
-- to R01/R02/R03/R05(historical); R03 HR Officers remain the site-scoped tier.
UPDATE site_scope SET scoped = false WHERE role_code IN ('R04', 'R06');
