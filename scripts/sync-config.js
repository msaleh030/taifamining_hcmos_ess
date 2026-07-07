#!/usr/bin/env node
'use strict';
// Registry key sync for LIVE tenants: adds keys that exist in DEFAULT_CONFIG
// but not in a tenant's config table (new keys shipped after the tenant was
// seeded). NEVER overwrites a LIVE value — registry values are Kira's to
// edit, not a deploy's — with ONE exception: a value still at the [TBC]
// sentinel was never a client decision, so when the shipped default has been
// DECIDED (no longer pending) the sentinel is promoted to it (e.g. LR-6
// 'default:1', Kira 2026-07-07). Retired keys are never deleted (harmless
// without a consumer, history stays inspectable). Idempotent; run after
// migrate on every deploy (the destructive seed only runs on a virgin DB).
const db = require('../src/db');
const { DEFAULT_CONFIG, PENDING, isPending } = require('../src/config');

async function main() {
  await db.withOwner(async (c) => {
    const tenants = (await c.query('SELECT company_id FROM tenant')).rows;
    // SELECT-driven (not command-tag-driven): compute what is missing, insert,
    // then VERIFY nothing is still missing — the report states facts.
    const missingOf = async (co) => {
      const have = new Set((await c.query(
        'SELECT key FROM config WHERE company_id=$1', [co])).rows.map((r) => r.key));
      return Object.keys(DEFAULT_CONFIG).filter((k) => !have.has(k));
    };
    let added = 0, promoted = 0;
    const addedKeys = new Set(), promotedKeys = new Set();
    for (const t of tenants) {
      for (const k of await missingOf(t.company_id)) {
        await c.query(
          `INSERT INTO config (company_id, key, value) VALUES ($1,$2,$3)
           ON CONFLICT (company_id, key) DO NOTHING`, [t.company_id, k, DEFAULT_CONFIG[k]]);
        added++; addedKeys.add(k);
      }
      // [TBC]-sentinel promotion: only where the live value is still PENDING
      // and the shipped default has been decided.
      for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
        if (isPending(v)) continue;
        const r = await c.query(
          `UPDATE config SET value=$3 WHERE company_id=$1 AND key=$2 AND value=$4`,
          [t.company_id, k, v, PENDING]);
        if (r.rowCount) { promoted += r.rowCount; promotedKeys.add(k); }
      }
      const still = await missingOf(t.company_id);
      if (still.length) throw new Error(`tenant ${t.company_id} still missing: ${still.join(', ')}`);
    }
    /* eslint-disable no-console */
    console.log(`[sync-config] ${added} missing key(s) added across ${tenants.length} tenant(s)` +
      (addedKeys.size ? `: ${[...addedKeys].sort().join(', ')}` : '') +
      (promoted ? ` · ${promoted} [TBC] sentinel(s) promoted to decided defaults: ${[...promotedKeys].sort().join(', ')}` : '') +
      ' — verified complete');
  });
  await db.close();
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
