'use strict';
// The CANONICAL six-site model (Kira, 2026-07-12). North Mara is TWO separate
// sites (projects) with independent HR scoping; Nyanzaga carries its project
// name; Dar Yard is new. Legacy coarse names are RENAMED in place (keeping the
// site id — every existing scope/zone/employee reference survives); missing
// canonical sites are created. Idempotent: re-runs change nothing.
//
//   UAT_COMPANY=<uuid> node scripts/canonical-sites.js
const db = require('../src/db');

const RENAMES = {
  'North Mara': 'North Mara - L&H and Airstrip Project',
  'Nyanzaga': 'Nyanzaga - Sotta Mining Project',
};
const CANONICAL = [
  'Head Office',
  'Mwadui',
  'North Mara - L&H and Airstrip Project',
  'North Mara - TSF Lift 10 Project',
  'Nyanzaga - Sotta Mining Project',
  'Dar Yard',
];

async function run(companyId) {
  if (!companyId) throw new Error('UAT_COMPANY (companyId) is required');
  return db.withOwner(async (c) => {
    const out = { renamed: [], created: [], present: [] };
    for (const [from, to] of Object.entries(RENAMES)) {
      const exists = (await c.query('SELECT 1 FROM site WHERE company_id=$1 AND name=$2', [companyId, to])).rows[0];
      if (exists) continue; // canonical name already in place
      const r = await c.query('UPDATE site SET name=$3 WHERE company_id=$1 AND name=$2', [companyId, from, to]);
      if (r.rowCount) out.renamed.push(`${from} -> ${to}`);
    }
    for (const name of CANONICAL) {
      const exists = (await c.query('SELECT 1 FROM site WHERE company_id=$1 AND name=$2', [companyId, name])).rows[0];
      if (exists) { out.present.push(name); continue; }
      await c.query('INSERT INTO site (company_id, name) VALUES ($1,$2)', [companyId, name]);
      out.created.push(name);
    }
    return out;
  });
}

async function main() {
  const res = await run(process.env.UAT_COMPANY);
  console.log(JSON.stringify(res, null, 2));
  await db.close();
}

if (require.main === module) main().catch((e) => { console.error('[sites] FAILED:', e.message); process.exit(1); });
module.exports = { run, CANONICAL, RENAMES };
