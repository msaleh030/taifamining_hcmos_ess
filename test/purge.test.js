'use strict';
// Scoped, audited scaffold purge (Kira-authorized, 2026-07-09) — the knife must
// cut ONLY synthetic seed rows at ONE site:
//   • scoped to the named site (identical scaffold at another site is untouched);
//   • only position-NULL rows with a non-numeric/absent legacy_id (every REAL
//     load carries a numeric PF — so PF 4429's blank position is protected);
//   • app_user-linked rows are KEPT and reported (a login-bearing record is
//     real by definition);
//   • dependents cleaned, one transaction, audited, idempotent.
// Runs against a throwaway site so the seeded North Mara fixtures stay intact.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const { run } = require('../scripts/purge-nm-scaffold');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const SITE_NAME = 'Zz Purge Test Site';
const OTHER_SITE = 'Zz Purge Other Site';

async function mkSite(name) {
  return (await owner(`INSERT INTO site(company_id,name) VALUES ($1,$2) RETURNING id`, [A, name])).rows[0].id;
}
async function mkEmp(siteId, { legacy, position = null, name }) {
  return (await owner(
    `INSERT INTO employee(company_id, site_id, full_name, legacy_id, emp_no, position, role_code, status)
     VALUES ($1,$2,$3,$4,$4,$5,'R01','active') RETURNING id`, [A, siteId, name, legacy, position])).rows[0].id;
}
const count = async (siteId) => Number((await owner(
  `SELECT count(*)::int n FROM employee WHERE site_id=$1`, [siteId])).rows[0].n);

before(H.start);
after(H.stop);

test('purge deletes ONLY site-scoped scaffold rows; real/linked/other-site rows survive; audited; idempotent', async () => {
  const site = await mkSite(SITE_NAME);
  const other = await mkSite(OTHER_SITE);
  const ids = {};
  try {
    // Scaffold (deletable): seed-style non-numeric legacy, no position.
    ids.scaf1 = await mkEmp(site, { legacy: 'E90001', name: 'Zz Scaffold One' });
    ids.scaf2 = await mkEmp(site, { legacy: 'E90002', name: 'Zz Scaffold Two' });
    // Scaffold with a dependent row (proves dependent cleanup).
    await owner(`INSERT INTO leave_carry(company_id,employee_id,days,carried_for_year,opening_bucket)
                 VALUES ($1,$2,3,2025,false)`, [A, ids.scaf1]);
    // REAL master row: numeric PF — survives even with position NULL (the PF
    // 4429 shape: real load, blank job title).
    ids.realBlank = await mkEmp(site, { legacy: '97001', name: 'Zz Real BlankPos' });
    // REAL master row with position — survives.
    ids.realPos = await mkEmp(site, { legacy: '97002', position: 'Welder', name: 'Zz Real WithPos' });
    // Scaffold-shaped but app_user-LINKED — KEPT and reported, never deleted.
    ids.linked = await mkEmp(site, { legacy: 'E90003', name: 'Zz Linked Scaffold' });
    const uid = (await owner(
      `INSERT INTO app_user(id, company_id, employee_id, email, password_hash, mfa_secret, role_code, status)
       VALUES (gen_random_uuid(),$1,$2,'zz.purge.linked@a.example','x','x','R01','active') RETURNING id`,
      [A, ids.linked])).rows[0].id;
    ids.uid = uid;
    // Identical scaffold at ANOTHER site — out of scope, must survive.
    ids.otherScaf = await mkEmp(other, { legacy: 'E90004', name: 'Zz OtherSite Scaffold' });

    const res = await run({ companyId: A, siteName: SITE_NAME });
    assert.equal(res.deleted, 2, 'exactly the two unlinked scaffold rows deleted');
    assert.equal(res.kept_app_user_linked, 1, 'the login-bearing row is KEPT and reported');
    assert.equal(res.remaining, 3, 'real (2) + linked (1) remain at the site');
    assert.ok((res.dependents_cleaned.leave_carry || 0) >= 1, 'the scaffold row\'s carry was cleaned with it');

    const left = (await owner(`SELECT id FROM employee WHERE site_id=$1`, [site])).rows.map((r) => r.id).sort();
    assert.deepEqual(left, [ids.realBlank, ids.realPos, ids.linked].sort(),
      'survivors are exactly: numeric-PF rows (blank position included) + the app_user-linked row');
    assert.equal(await count(other), 1, 'the other site\'s scaffold is untouched (strict site scoping)');

    // Audited on the hash-chain with the criteria + counts.
    const aud = (await owner(
      `SELECT after FROM audit WHERE company_id=$1 AND action='employee.scaffold.purge' AND entity_id=$2::text
        ORDER BY seq DESC LIMIT 1`, [A, site])).rows[0];
    assert.ok(aud, 'purge event is on the audit chain');
    assert.equal(aud.after.deleted, 2);
    assert.match(aud.after.criteria, /site-scoped AND position IS NULL/);

    // Idempotent: a re-run finds nothing.
    const again = await run({ companyId: A, siteName: SITE_NAME });
    assert.equal(again.deleted, 0, 're-run deletes nothing');
    assert.equal(again.remaining, 3);
  } finally {
    if (ids.uid) await owner(`DELETE FROM app_user WHERE id=$1`, [ids.uid]);
    for (const k of ['scaf1', 'scaf2', 'realBlank', 'realPos', 'linked', 'otherScaf']) {
      if (ids[k]) {
        await owner(`DELETE FROM leave_carry WHERE employee_id=$1`, [ids[k]]);
        await owner(`DELETE FROM employee WHERE id=$1`, [ids[k]]);
      }
    }
    await owner(`DELETE FROM site WHERE id IN ($1,$2)`, [site, other]);
  }
});

test('purge REFUSES an unknown site (fail-closed, nothing deleted)', async () => {
  await assert.rejects(run({ companyId: A, siteName: 'Zz No Such Site' }), /site .* not found .* nothing purged/);
});

test('purge REFUSES without a tenant id', async () => {
  await assert.rejects(run({}), /UAT_COMPANY .* required/);
});
