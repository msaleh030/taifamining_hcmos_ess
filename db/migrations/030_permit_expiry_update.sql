-- ===========================================================================
-- 030 — permit re-runs update expiry (idempotent permit ingest, 2026-07-12)
-- ===========================================================================
-- Permits now load on every deploy alongside the other masters; a re-run
-- refreshes valid_until on the existing (person, permit-name) document instead
-- of stacking duplicates. Least privilege: ONLY the expiry column is
-- updatable — identity (employee_id, kind, name) stays immutable to the app
-- role, and RLS (USING + WITH CHECK) still pins the tenant.
GRANT UPDATE (valid_until) ON employee_document TO hcmos_app;
