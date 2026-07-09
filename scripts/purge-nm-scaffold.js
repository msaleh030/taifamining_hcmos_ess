'use strict';
// Scoped, audited purge of SYNTHETIC SEED SCAFFOLD employees for ONE site —
// authorized by Kira (2026-07-09) to clear North Mara's ~2,711 seed rows before
// the real 285-employee master loads. Fail-closed by construction:
//
//   A row is a purge candidate ONLY if ALL of:
//     • it belongs to the target tenant AND the target site (North Mara);
//     • position IS NULL (the real master always writes position — even the one
//       blank-position row is protected by the next rule);
//     • legacy_id is NULL or NON-NUMERIC (seed scaffold uses 'E00001'-style ids;
//       every REAL loaded employee carries a numeric PF as legacy_id);
//     • NO app_user references it (a login-bearing employee record is real by
//       definition — such rows are KEPT and reported, never deleted).
//
//   The whole run is ONE transaction, re-verified row-by-row before any delete,
//   and lands on the audit hash-chain (employee.scaffold.purge). Idempotent:
//   a re-run finds 0 candidates and deletes nothing.
//
//   UAT_COMPANY=<uuid> [PURGE_SITE='North Mara'] node scripts/purge-nm-scaffold.js
const db = require('../src/db');

async function run({ companyId, siteName = 'North Mara', actor = 'deploy@railgrid.tz (Kira-authorized 2026-07-09)' } = {}) {
  if (!companyId) throw new Error('UAT_COMPANY (companyId) is required');
  return db.withOwner(async (c) => {
    await c.query('BEGIN');
    try {
      const site = (await c.query(
        'SELECT id FROM site WHERE company_id=$1 AND name=$2', [companyId, siteName])).rows[0];
      if (!site) throw new Error(`site "${siteName}" not found for tenant — nothing purged`);

      const before = Number((await c.query(
        'SELECT count(*)::int n FROM employee WHERE company_id=$1 AND site_id=$2', [companyId, site.id])).rows[0].n);

      // Candidate selection — the four criteria, in SQL, into a temp table so
      // every later statement works from ONE frozen, verifiable set.
      await c.query(`CREATE TEMP TABLE purge_ids ON COMMIT DROP AS
        SELECT e.id FROM employee e
         WHERE e.company_id=$1 AND e.site_id=$2
           AND e.position IS NULL
           AND (e.legacy_id IS NULL OR e.legacy_id !~ '^[0-9]+$')
           AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.employee_id = e.id)`,
        [companyId, site.id]);
      const candidates = Number((await c.query('SELECT count(*)::int n FROM purge_ids')).rows[0].n);

      // Kept-but-matching rows (app_user-linked, position-null, non-numeric id):
      // reported so the count reconciliation is honest, never silently absorbed.
      const keptLinked = Number((await c.query(
        `SELECT count(*)::int n FROM employee e
          WHERE e.company_id=$1 AND e.site_id=$2 AND e.position IS NULL
            AND (e.legacy_id IS NULL OR e.legacy_id !~ '^[0-9]+$')
            AND EXISTS (SELECT 1 FROM app_user u WHERE u.employee_id = e.id)`,
        [companyId, site.id])).rows[0].n);

      // RE-VERIFY the frozen set against every criterion (defence in depth —
      // any violation aborts the whole transaction).
      const bad = Number((await c.query(
        `SELECT count(*)::int n FROM purge_ids p JOIN employee e ON e.id = p.id
          WHERE e.company_id <> $1 OR e.site_id <> $2
             OR e.position IS NOT NULL
             OR (e.legacy_id IS NOT NULL AND e.legacy_id ~ '^[0-9]+$')
             OR EXISTS (SELECT 1 FROM app_user u WHERE u.employee_id = e.id)`,
        [companyId, site.id])).rows[0].n);
      if (bad > 0) throw new Error(`SAFETY ABORT: ${bad} candidate(s) failed re-verification — nothing deleted`);

      // Dependent rows: discover every FK onto employee(id) from the catalog so
      // a future table can never be missed. SET NULL constraints self-handle;
      // the rest are deleted (two passes for any child-of-child ordering).
      const fks = (await c.query(`
        SELECT conrelid::regclass::text AS tbl,
               (SELECT attname FROM pg_attribute WHERE attrelid = conrelid AND attnum = conkey[1]) AS col,
               confdeltype
          FROM pg_constraint
         WHERE contype='f' AND confrelid='employee'::regclass`)).rows
        .filter((f) => f.confdeltype !== 'n' && f.tbl !== 'app_user');
      const cleaned = {};
      let pending = fks;
      for (let pass = 0; pass < 2 && pending.length; pass++) {
        const failed = [];
        for (const f of pending) {
          try {
            const r = await c.query(`DELETE FROM ${f.tbl} WHERE ${f.col} IN (SELECT id FROM purge_ids)`);
            if (r.rowCount) cleaned[f.tbl] = (cleaned[f.tbl] || 0) + r.rowCount;
          } catch (e) { failed.push(f); }
        }
        pending = failed;
      }
      if (pending.length) throw new Error(`dependent cleanup failed for: ${pending.map((f) => f.tbl).join(', ')}`);

      const del = await c.query('DELETE FROM employee WHERE id IN (SELECT id FROM purge_ids)');
      const deleted = del.rowCount;
      if (deleted !== candidates) throw new Error(`SAFETY ABORT: deleted ${deleted} != candidates ${candidates}`);

      const remaining = Number((await c.query(
        'SELECT count(*)::int n FROM employee WHERE company_id=$1 AND site_id=$2', [companyId, site.id])).rows[0].n);

      // On the audit hash-chain: who authorized it, the exact criteria, counts.
      await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
        companyId, actor, 'R12', 'employee.scaffold.purge', 'site', site.id,
        JSON.stringify({ site: siteName, rows_before: before }),
        JSON.stringify({ deleted, kept_app_user_linked: keptLinked, remaining,
          criteria: 'site-scoped AND position IS NULL AND legacy_id null-or-non-numeric AND no app_user link',
          dependents_cleaned: cleaned })]);

      await c.query('COMMIT');
      return { site: siteName, rows_before: before, candidates, deleted,
        kept_app_user_linked: keptLinked, remaining, dependents_cleaned: cleaned };
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  });
}

async function main() {
  const res = await run({ companyId: process.env.UAT_COMPANY, siteName: process.env.PURGE_SITE || 'North Mara' });
  console.log(JSON.stringify(res, null, 2));
  await db.close();
}

if (require.main === module) main().catch((e) => { console.error('[purge] REFUSED:', e.message || e); process.exit(1); });
module.exports = { run };
