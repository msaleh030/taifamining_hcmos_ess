'use strict';
// Leave service — currently the LR-4 carry-forward lapse nightly job.
//
// LR-3 (calendar-year) + LR-4 (carry lapses after a configurable number of
// years; LOCKED = 1, CHANGED from 2). The lapse window is read from the registry
// per request — nothing here hard-codes "1" (or "2"). A carried entry for year Y
// remains usable through the end of year Y + lapse_years and lapses thereafter.
const db = require('./db');
const cfg = require('./config');

// Run the nightly carry-lapse for one tenant, as of `asOf` (a YYYY-MM-DD string;
// injected so the job is deterministic and testable rather than clock-bound).
// Marks every still-open carry whose window has closed as lapsed, on the audit
// chain. Returns the rows it lapsed.
async function lapseCarry(companyId, asOf) {
  return db.withTenant(companyId, async (c) => {
    // Registry-gated: lapse window must be a confirmed value (blocks if [TBC]).
    const lapseYears = await cfg.getRequiredInt(companyId, 'leave.carry.lapse_years', c);

    // A carry for year Y lapses once asOf's calendar year exceeds Y + lapseYears.
    const r = await c.query(
      `UPDATE leave_carry
          SET lapsed_at = $1::timestamptz
        WHERE lapsed_at IS NULL
          AND carried_for_year + $2 < EXTRACT(YEAR FROM $1::date)
        RETURNING id, employee_id, days, carried_for_year`,
      [asOf, lapseYears]);

    for (const row of r.rows) {
      await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
        companyId, 'system@nightly', 'SYS', 'leave.carry.lapse',
        'leave_carry', row.id,
        { days: Number(row.days), carried_for_year: row.carried_for_year },
        { days: 0, lapsed: true }]);
    }
    return { lapsed: r.rows, lapse_years: lapseYears, as_of: asOf };
  });
}

module.exports = { lapseCarry };
