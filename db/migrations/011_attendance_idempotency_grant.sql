-- ===========================================================================
-- 011 — F5: allow the app role to write the idempotency ledger directly.
-- ===========================================================================
-- Slice 1 created `idempotency` with SELECT-only for hcmos_app: at the time the
-- only writer was the field-auth SECURITY DEFINER function (which runs as owner).
-- F5's self-service clock-in dedupes an offline punch in-line (same withTenant
-- transaction that inserts the attendance row), so the app role now needs INSERT.
-- This mirrors slice 9, which granted direct INSERT on the attendance-module
-- tables. RLS still scopes every row to the tenant (tenant_isolation WITH CHECK).
GRANT INSERT ON idempotency TO hcmos_app;
