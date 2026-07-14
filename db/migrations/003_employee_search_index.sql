-- HCMOS ESS — tenant-aware substring-search index for the directory.
--
-- The Slice 2 trigram index was on full_name alone, so under RLS the planner had
-- to recheck company_id and (on small tables) preferred a seq scan. A COMPOSITE
-- GIN combining btree_gin (company_id) + trigram (full_name / emp_no) lets a
-- single index satisfy BOTH the tenant predicate and the ILIKE search — so the
-- directory search stays index-driven as a tenant grows toward 10,000+ rows
-- (UNI-02: first page within budget, no full-table load).

SET client_min_messages = warning;

DROP INDEX IF EXISTS employee_fullname_trgm_idx;
DROP INDEX IF EXISTS employee_empno_trgm_idx;

CREATE INDEX IF NOT EXISTS employee_search_name_idx
  ON employee USING gin (company_id, full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS employee_search_empno_idx
  ON employee USING gin (company_id, emp_no gin_trgm_ops);
