-- ===========================================================================
-- 004 — Employee-number scheme change: TMCL-<LOC>-<SEQ>, per-location sequence
-- ===========================================================================
-- New scheme: prefix TMCL, a location code, and a per-location zero-padded
-- sequence (no year segment, not globally numbered, not year-reset).
--
-- EN-6 (unchanged): existing/legacy numbers are RETAINED as legacy_id; the new
-- format applies to joiners from go-live. Pre-go-live employees are grandfathered
-- (their legacy number stays usable) and are NOT renumbered.
--
-- Config, not code: the location ENUM (incl. whether Nyanzaga is enabled),
-- the prefix, the SEQ width, and rollover policy all live in the `config`
-- registry and are enforced by the application generator (src/empno.js). This
-- migration only adds durable structures + a STRUCTURAL backstop constraint, so
-- a malformed value can never be persisted even if a future writer bypasses the
-- generator. It is additive — no data is dropped.

-- ---------------------------------------------------------------------------
-- Legacy identifier — the pre-go-live number, retained per EN-6.
-- ---------------------------------------------------------------------------
ALTER TABLE employee ADD COLUMN IF NOT EXISTS legacy_id text;

-- Retain any number already assigned as the legacy id (idempotent backfill,
-- runs before the format constraint below so existing rows are grandfathered).
UPDATE employee SET legacy_id = emp_no
 WHERE legacy_id IS NULL AND emp_no IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS employee_legacy_key
  ON employee (company_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Per-location sequence counters — one row per (tenant, location code).
-- The application allocates the next SEQ with a single atomic
-- INSERT … ON CONFLICT DO UPDATE, which serialises on the counter row so
-- simultaneous joiners at the same location never collide. This table is the
-- source of truth for SEQ; it is seeded from max(existing) on first use.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS empno_counter (
  company_id uuid    NOT NULL REFERENCES tenant(company_id),
  location   text    NOT NULL,
  next_seq   integer NOT NULL,
  PRIMARY KEY (company_id, location)
);

ALTER TABLE empno_counter ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON empno_counter;
CREATE POLICY tenant_isolation ON empno_counter
  USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- ---------------------------------------------------------------------------
-- Structural backstop constraint.
-- A NEW joiner (no legacy_id) must carry a well-formed new-scheme number; legacy
-- rows are grandfathered, and NULL is allowed (number not yet assigned). The
-- exact location enum/prefix/width are config-driven and enforced by the
-- generator — this constraint only fixes the *shape* (prefix TMCL, an uppercase
-- location code, a 4-digit sequence) so malformed values cannot be persisted.
-- If config.empno.seq_width ever changes, migrate this constraint too.
-- ---------------------------------------------------------------------------
ALTER TABLE employee DROP CONSTRAINT IF EXISTS employee_empno_format;
ALTER TABLE employee ADD CONSTRAINT employee_empno_format CHECK (
  emp_no IS NULL
  OR legacy_id IS NOT NULL
  OR emp_no ~ '^TMCL-[A-Z]{2,}-[0-9]{4}$'
);

GRANT SELECT, INSERT, UPDATE ON empno_counter TO hcmos_app;
