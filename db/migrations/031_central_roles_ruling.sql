-- ===========================================================================
-- 031 — central-scope ruling (Kira, 2026-07-12 second ruling)
-- ===========================================================================
-- R04 (HR Manager), R07 (Payroll Officer), R12 (System Administrator),
-- R14 (CEO/Executive), R15 (Finance Manager), R16 (Chief Financial
-- Controller) are CENTRAL — they see all sites. R06/R11 were already central
-- (migrations 029 / v1.5 seed). Site-bound tier stays R01/R02/R03/R05/R13.
-- Upsert (not bare UPDATE) so the ruling holds even where a role row was
-- never seeded — the fallback config alone must not carry a security rule.
INSERT INTO site_scope (role_code, scoped) VALUES
  ('R04', false), ('R07', false), ('R12', false),
  ('R14', false), ('R15', false), ('R16', false)
ON CONFLICT (role_code) DO UPDATE SET scoped = false;

-- Same ruling: ONLY the Head of HR performs CRUD on expatriate records. R11
-- was checker-only in the maker sets, which would leave expat records with NO
-- possible maker — the Head of HR joins the maker tier (the R11-only expat
-- gate itself is application logic on 'expat.crud.roles'). Existing tenant
-- rows are amended in place (sync-config only ADDS missing keys).
UPDATE config SET value = value || ',R11'
 WHERE key IN ('field_change.makers', 'field_change.makers.phone')
   AND value NOT LIKE '%R11%';
