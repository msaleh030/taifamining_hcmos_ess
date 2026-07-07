#!/usr/bin/env node
'use strict';
// Registry key sync for LIVE tenants: adds keys that exist in DEFAULT_CONFIG
// but not in a tenant's config table (new keys shipped after the tenant was
// seeded). NEVER overwrites an existing value — live registry values are
// Kira's to edit, not a deploy's — and never deletes retired keys (harmless
// without a consumer, and history stays inspectable). Idempotent; run after
// migrate on every deploy (the destructive seed only runs on a virgin DB).
const db = require('../src/db');
const { DEFAULT_CONFIG } = require('../src/config');

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
    let added = 0;
    const addedKeys = new Set();
    for (const t of tenants) {
      for (const k of await missingOf(t.company_id)) {
        await c.query(
          `INSERT INTO config (company_id, key, value) VALUES ($1,$2,$3)
           ON CONFLICT (company_id, key) DO NOTHING`, [t.company_id, k, DEFAULT_CONFIG[k]]);
        added++; addedKeys.add(k);
      }
      const still = await missingOf(t.company_id);
      if (still.length) throw new Error(`tenant ${t.company_id} still missing: ${still.join(', ')}`);
    }
    /* eslint-disable no-console */
    console.log(`[sync-config] ${added} missing key(s) added across ${tenants.length} tenant(s)` +
      (addedKeys.size ? `: ${[...addedKeys].sort().join(', ')}` : '') + ' — verified complete');
  });
  await db.close();
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
