-- ===========================================================================
-- 035 — Wave 5: CEO read-only registry key (2026-07-14)
-- ===========================================================================
-- The Wave-5 structural read-only guard reads config 'auth.readonly.roles'
-- (the roles barred at the HTTP layer from every mutating route, bar a
-- readonlyOk exception). The code carries an inline 'R14' fallback, but the
-- registry discipline is that a SECURITY rule must EXIST as a config row per
-- tenant, not live only in a code default. Seed it for every existing tenant,
-- idempotently — never overwrite a tenant that has already tuned it.
INSERT INTO config (company_id, key, value)
SELECT company_id, 'auth.readonly.roles', 'R14' FROM tenant
ON CONFLICT (company_id, key) DO NOTHING;
