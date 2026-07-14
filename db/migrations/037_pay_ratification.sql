-- ===========================================================================
-- 037 — Pay-component ratification (Kira, 2026-07-14; official NM export,
--       285 rows / 231 complete records, proved by arithmetic)
-- ===========================================================================
-- 1. exact_column v1.2 headers: the provisional abbreviations were AMBIGUOUS
--    against a contract carrying BOTH Fixed and Variable housing/transport
--    columns, and MEDICAL was a phantom. Rename to the OFFICIAL header strings
--    (character for character). Matching is exact-after-normalisation, so the
--    config lists below and these headers move together.
UPDATE exact_column SET header='Rotation Allowance'        WHERE version='v1.2' AND position=11;
UPDATE exact_column SET header='Basic Salary'              WHERE version='v1.2' AND position=12;
UPDATE exact_column SET header='Housing Allowance (Fixed)' WHERE version='v1.2' AND position=13;
UPDATE exact_column SET header='Responsibility Allowance'  WHERE version='v1.2' AND position=14;
UPDATE exact_column SET header='Project Allowance'         WHERE version='v1.2' AND position=15;
-- MEDICAL (16) is a PHANTOM — no such component exists in the official
-- contract. Revert to the un-named placeholder; money appearing there flags as
-- unclassified (fail-closed), never summed. pinned stays false.
UPDATE exact_column SET header='ALLOWANCES 16', pinned=false WHERE version='v1.2' AND position=16;
UPDATE exact_column SET header='House Allowance(Variable)' WHERE version='v1.2' AND position=17;
UPDATE exact_column SET header='Fixed Overtime'            WHERE version='v1.2' AND position=19;
UPDATE exact_column SET header='Transport Allowance(Fixed)' WHERE version='v1.2' AND position=20;
UPDATE exact_column SET header='Overtime - Normal Days'    WHERE version='v1.2' AND position=21;
UPDATE exact_column SET header='Overtime - Holidays'       WHERE version='v1.2' AND position=24;
UPDATE exact_column SET header='Night Allowance'           WHERE version='v1.2' AND position=26;

-- 2. Config: these are RULINGS — upsert-overwrite (never DO NOTHING) so a stale
--    tenant value cannot survive the ratification.
INSERT INTO config (company_id, key, value)
SELECT company_id, 'exact.dailyrate.include_names',
       'Basic Salary,Fixed Overtime,Project Allowance,Responsibility Allowance,Housing Allowance (Fixed),Transport Allowance(Fixed)'
  FROM tenant
ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO config (company_id, key, value)
SELECT company_id, 'exact.dailyrate.exclude_names',
       'Rotation Allowance,Night Allowance,Overtime - Normal Days,Overtime - Holidays,Transport Allowance(variable),House Allowance(Variable),Gross Salary Arrears,Terminal Dues,Overdraft'
  FROM tenant
ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value;

-- PENDING CECILIA — the gate stays CLOSED on these two (Local Conveyance:
-- 182 people, flat 25,000; TSF Allowance: 8 people, flat 133,088). Money in
-- either blocks the figure NAMING the component. Do not guess.
INSERT INTO config (company_id, key, value)
SELECT company_id, 'exact.dailyrate.pending_names', 'Local Conveyance,TSF Allowance' FROM tenant
ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value;

-- 3. The classification itself is now RATIFIED (this ruling): the general gate
--    opens; the two pending components above still block row-by-row wherever
--    they carry money, by name.
INSERT INTO config (company_id, key, value)
SELECT company_id, 'exact.dailyrate.classification.ratified', 'true' FROM tenant
ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value;
