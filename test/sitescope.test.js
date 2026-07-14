'use strict';
// Site-scope gate — the shared, reusable rule (src/sitescope.js) that any per-site
// endpoint must use so a site-bound role sees only its own site's data. The
// directory already applies it; C11 Performance (deferred) MUST route through it
// when built. This pins the gate itself, independent of any one screen.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const sitescope = require('../src/sitescope');
const { F } = H;

const A = F.TENANT_A;

before(H.start);
after(H.stop);

test('site-scope gate: site-bound roles are scoped to their own site; central roles are not', async () => {
  await db.withTenant(A, async (c) => {
    // isScoped: R02 (Supervisor) is site-bound; R07 (Payroll) is central.
    assert.equal(await sitescope.isScoped(c, 'R02'), true, 'supervisor is site-bound');
    assert.equal(await sitescope.isScoped(c, 'R07'), false, 'payroll is central');

    // requesterSite resolves the caller's own site from their employee record.
    const supSession = { company_id: A, user_id: F.USERS.SUP_A.id, role_code: 'R02' };
    assert.equal(await sitescope.requesterSite(c, supSession), F.SITE.A1, 'supervisor resolves to site A1');

    // scopeSite: a site-bound role gets its site (a WHERE-clause filter); a central
    // role gets null (no site filter — sees the whole tenant, still RLS-isolated).
    assert.equal(await sitescope.scopeSite(c, supSession), F.SITE.A1, 'scoped role → own site');
    const paySession = { company_id: A, user_id: F.USERS.PAYROLL_A.id, role_code: 'R07' };
    assert.equal(await sitescope.scopeSite(c, paySession), null, 'central role → no site restriction');

    // bughunt-B #11 + multi-site: the explicit three-state contract by mode —
    // 'all' (central), 'sites' (the scope SET, single-site = a one-element set),
    // 'none' (unresolved → deny).
    assert.deepEqual(await sitescope.scopeSiteMode(c, supSession),
      { mode: 'sites', siteIds: [F.SITE.A1], siteId: F.SITE.A1 });
    assert.deepEqual(await sitescope.scopeSiteMode(c, paySession), { mode: 'all' });
  });
});

// ── bughunt-B #11: fail-CLOSED — a site-bound role whose site cannot be
// resolved must be DENIED, never handed the org-wide view a bare null implied. ─
test('site-scope gate: a site-bound role with no resolvable site is denied, not org-wide', async () => {
  await db.withTenant(A, async (c) => {
    // A site-bound session with no employee record behind it (site unresolvable).
    const orphan = { company_id: A, user_id: null, role_code: 'R02' };
    assert.deepEqual(await sitescope.scopeSiteMode(c, orphan), { mode: 'none' }, 'unresolved ≠ central');
    await assert.rejects(() => sitescope.scopeSite(c, orphan), /site scope unresolved/,
      'scopeSite throws (403) instead of returning a null a consumer would read as "no filter"');
  });
});

// ── Multi-site scope (Kira 2026-07-12): the North Mara HR Officer sees BOTH
// NM projects — a SET of sites per user (user_site_scope), never a merge. No
// rows → the employee record's single site (everyone else unchanged). ────────
test('multi-site scope: a user with user_site_scope rows resolves the SET; sees exactly those sites', async () => {
  const employees = require('../src/employees');
  const addScope = (siteId) => db.withOwner((c) => c.query(
    `INSERT INTO user_site_scope(company_id, user_id, site_id) VALUES ($1,$2,$3)`,
    [A, F.USERS.SUP_A.id, siteId]));
  const supSession = { company_id: A, user_id: F.USERS.SUP_A.id, role_code: 'R02' };
  try {
    // Baseline (no rows): single-site default from the employee record.
    await db.withTenant(A, async (c) => {
      assert.deepEqual(await sitescope.requesterSites(c, supSession), [F.SITE.A1], 'no rows → employee-record site');
    });
    // Two-scope set: BOTH sites resolve; both remain distinct.
    await addScope(F.SITE.A1);
    await addScope(F.SITE.A2);
    await db.withTenant(A, async (c) => {
      const mode = await sitescope.scopeSiteMode(c, supSession);
      assert.equal(mode.mode, 'sites');
      assert.deepEqual([...mode.siteIds].sort(), [F.SITE.A1, F.SITE.A2].sort(), 'the scope is the SET');
      const sites = await sitescope.scopeSites(c, supSession);
      assert.equal(sites.length, 2);
    });
    // The directory: she sees employees at BOTH her sites, and NOT a third.
    const dir = await employees.list(supSession, { limit: 200, q: 'E-A-000' });
    const bySite = new Set(dir.rows.map((r) => r.site_id));
    assert.ok(bySite.has(F.SITE.A1) && bySite.has(F.SITE.A2), 'both scoped sites visible');
    assert.ok(!bySite.has(F.SITE.HO), 'a site OUTSIDE the set is never visible');
    // Fail-closed unchanged (#11): a site-bound role with NO resolvable scope denies.
    await db.withTenant(A, async (c) => {
      const orphan = { company_id: A, user_id: null, role_code: 'R02' };
      await assert.rejects(() => sitescope.scopeSites(c, orphan), /site scope unresolved/);
    });
  } finally {
    await db.withOwner((c) => c.query(`DELETE FROM user_site_scope WHERE user_id=$1`, [F.USERS.SUP_A.id]));
  }
});
