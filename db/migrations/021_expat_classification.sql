-- ===========================================================================
-- 021 — Expat classification (Kira, 2026-07-06): BOTH permit-type and
--       contract-expiry routing key off expat-vs-local, so the flag lives at
--       the EMPLOYEE level. Driven by the authoritative 61-name
--       expat-permit-classification.csv via scripts/classify-expats.js —
--       matches are set from the list, NEVER guessed; the CSV itself is
--       client PII (names/passports) and never enters the repo.
-- ===========================================================================
ALTER TABLE employee ADD COLUMN IF NOT EXISTS is_expat boolean NOT NULL DEFAULT false;
