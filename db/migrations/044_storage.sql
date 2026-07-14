-- ===========================================================================
-- 044 — ONE storage foundation (Kira ruling 2026-07-14). Phase 1.
-- ===========================================================================
-- Metadata for every stored binary (punch photos, ESS documents, future
-- uploads): kind, owner entity, PATH (never base64), size, sha256 integrity
-- hash, virus-scan status, retention evidence. The binary lives on the
-- storage driver (local disk under StateDirectory now; object store later).
CREATE TABLE IF NOT EXISTS stored_object (
  id           uuid PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES tenant(company_id),
  kind         text NOT NULL CHECK (kind IN ('punch-photo','ess-doc')),
  owner_entity text,           -- e.g. 'attendance', 'employee'
  owner_id     text,           -- the owning row's id
  path         text NOT NULL,
  size         bigint NOT NULL CHECK (size > 0),
  sha256       text NOT NULL,
  content_type text,
  scan_status  text NOT NULL DEFAULT 'pending'
               CHECK (scan_status IN ('pending','clean','infected','unavailable')),
  scanned_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz   -- retention sweep: binary unlinked, row retained as evidence
);

CREATE INDEX IF NOT EXISTS stored_object_owner_idx ON stored_object (company_id, owner_entity, owner_id);
CREATE INDEX IF NOT EXISTS stored_object_retention_idx ON stored_object (company_id, kind, created_at) WHERE deleted_at IS NULL;

ALTER TABLE stored_object ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON stored_object;
CREATE POLICY tenant_isolation ON stored_object
  USING (company_id = current_company()) WITH CHECK (company_id = current_company());

GRANT SELECT, INSERT, UPDATE ON stored_object TO hcmos_app;
