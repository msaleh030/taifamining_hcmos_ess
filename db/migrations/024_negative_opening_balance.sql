-- ===========================================================================
-- 024 — Negative opening balance (Omid's ruling, 2026-07-09).
-- ===========================================================================
-- A leave shortfall (e.g. Juliana Buyinza, PF 4150) must be carried as a
-- NEGATIVE opening balance that offsets future accrual — NOT loaded as zero.
-- The opening bucket previously inherited leave_carry's CHECK (days >= 0), which
-- hard-rejected a negative row. Relax it so ONLY the protected opening bucket
-- may hold a negative (a deficit); normal carry rows stay >= 0 because the FIFO
-- forfeiture/cap sweep assumes non-negative balances.
ALTER TABLE leave_carry DROP CONSTRAINT IF EXISTS leave_carry_days_check;
ALTER TABLE leave_carry ADD CONSTRAINT leave_carry_days_check
  CHECK (days >= 0 OR opening_bucket = true);
