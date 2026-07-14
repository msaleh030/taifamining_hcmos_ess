'use strict';
// Wave 6 — daily expatriate/document expiry alert sweep.
//
// This is ONLY a tenant loop + a stable UTC asOf. All the intelligence — DA-2
// routing (expat & unclassified permits fail CLOSED to the Head of HR R11;
// business permits/licences → SHEQ R06; medical + LOCAL contract → the
// site-matched HR Officer R03), repeat-until-renewed, clear-on-renewal, and
// per-asOf idempotency — already lives in docalerts.runExpiryAlerts. Wave 6
// wires that engine to a systemd timer (deploy/hcmos-expiry-alerts.{service,
// timer}); nothing routing-related is duplicated here.
//
// Idempotent by construction: running twice on the same day is a no-op (the
// sweep skips a still-open alert already notified as of this asOf), so a missed
// timer tick that Persistent=true replays cannot double-notify.
//
//   node scripts/run-expiry-alerts.js [YYYY-MM-DD]   (defaults to today, UTC)
const db = require('../src/db');
const docalerts = require('../src/docalerts');

function todayUtc() { return new Date().toISOString().slice(0, 10); }

// Sweep every tenant as of `asOf`. Returns one result object per tenant.
async function sweepAllTenants(asOf) {
  const tenants = (await db.withOwner((c) => c.query('SELECT company_id FROM tenant ORDER BY company_id'))).rows;
  const results = [];
  for (const t of tenants) {
    const r = await docalerts.runExpiryAlerts({ company_id: t.company_id }, asOf);
    results.push({ company: t.company_id, ...r });
    console.log(JSON.stringify({ company: t.company_id, as_of: asOf,
      raised: r.raised.length, cleared: r.cleared.length, open: r.open_count, unclassified: r.unclassified_count }));
  }
  console.log(`[expiry-alerts] swept ${tenants.length} tenant(s), asOf=${asOf}`);
  return results;
}

module.exports = { sweepAllTenants, todayUtc };

if (require.main === module) {
  const asOf = process.argv[2] || todayUtc();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error(`[expiry-alerts] bad asOf (want YYYY-MM-DD): ${asOf}`); process.exit(2); }
  sweepAllTenants(asOf)
    .then(() => db.close())
    .catch((e) => { console.error('[expiry-alerts] FAILED:', e.message); db.close().finally(() => process.exit(1)); });
}
