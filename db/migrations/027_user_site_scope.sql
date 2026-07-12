-- ===========================================================================
-- 027 — Multi-site scope per user (Kira 2026-07-12)
-- ===========================================================================
-- The North Mara HR Officer is scoped to BOTH North Mara projects — two
-- DISTINCT sites (never merged). The employee record still anchors at ONE site
-- (identity); this table carries the USER'S visibility set. Rules:
--   • no rows for a user → their scope is their employee record's site (the
--     one-officer-one-site default, unchanged for every other R03);
--   • rows present → the scope set is EXACTLY those sites;
--   • a site-bound role whose set resolves EMPTY is DENIED (fail-closed, #11).
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS user_site_scope (
  company_id uuid NOT NULL REFERENCES tenant(company_id),
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  site_id    uuid NOT NULL REFERENCES site(id),
  PRIMARY KEY (company_id, user_id, site_id)
);

ALTER TABLE user_site_scope ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON user_site_scope;
CREATE POLICY tenant_isolation ON user_site_scope
  USING (company_id = current_company()) WITH CHECK (company_id = current_company());

GRANT SELECT, INSERT, DELETE ON user_site_scope TO hcmos_app;
