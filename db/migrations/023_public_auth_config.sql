-- ===========================================================================
-- 023 — Public login config (setup-phase MFA toggle support).
-- ===========================================================================
-- The login UI (pre-auth) must know whether to render the MFA field, driven by
-- the SAME auth.mfa.required key the server enforces. The tenant table is under
-- RLS, so the app role can't read it without a company context — this
-- SECURITY DEFINER function resolves the primary (lowest company_id) active
-- tenant's flag, bypassing RLS to return only a non-secret boolean. Enforcement
-- itself stays per-tenant on the actual login.
CREATE OR REPLACE FUNCTION auth_public_config()
RETURNS TABLE(mfa_required boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(config_get(t.company_id, 'auth.mfa.required'), '1') <> '0'
    FROM tenant t WHERE t.status = 'active' ORDER BY t.company_id LIMIT 1
$$;
