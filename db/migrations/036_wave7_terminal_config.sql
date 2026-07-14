-- ===========================================================================
-- 036 — Wave 7: terminal/severance dues registry keys (2026-07-14)
-- ===========================================================================
-- TD-1: the statutory days-of-basic-wage per completed year of service is a
-- legal value that MUST be confirmed in the registry, never guessed. Seed it
-- PENDING ('__TBC__') for every existing tenant so the key EXISTS and is
-- auditable, while GET /liability/terminal/:batch BLOCKS with 409 until Kira/
-- Omid confirm the rate. The qualifying service threshold ships a structural
-- default (1 year) — confirm at UAT. Idempotent; never overwrite a tenant that
-- has already tuned either value.
INSERT INTO config (company_id, key, value)
SELECT company_id, 'terminal.severance.days_per_year', '__TBC__' FROM tenant
ON CONFLICT (company_id, key) DO NOTHING;

INSERT INTO config (company_id, key, value)
SELECT company_id, 'terminal.min_service_years', '1' FROM tenant
ON CONFLICT (company_id, key) DO NOTHING;
