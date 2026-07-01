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
  });
});
