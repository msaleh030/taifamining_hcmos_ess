'use strict';
// F8 — Tenant provisioning wizard (C21, TEN-01/02/03) as INTEGRATION tests through
// the real HTTP endpoint, around the slice-10 provisioning backend. Proves:
//   • the wizard provisions a tenant, seeded FROM THE REGISTRY (config + sites);
//   • a mid-provision fault (NODE_ENV seam) rolls back atomically — nothing
//     half-created;
//   • a non-admin role is refused at the endpoint (highest-privilege action);
//   • isolation: the new tenant's data is invisible to another tenant and the
//     provisioning call does not touch the caller's tenant (RLS holds).
// The companyId is minted server-side, so a caller can never target another tenant.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('./helpers');
const db = require('../src/db');
const { DEFAULT_CONFIG } = require('../src/config');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG).length;
const SITES = 4; // HO, MW, NM, NZ — the enabled LOC codes in empno.locations

// Mirror slice10's cleanup: config/site/tenant are removed; the audit genesis
// event is left (the chain is append-only — DELETE is rejected by design).
async function purge(cid) {
  await owner(`DELETE FROM site WHERE company_id=$1`, [cid]);
  await owner(`DELETE FROM config WHERE company_id=$1`, [cid]);
  await owner(`DELETE FROM tenant WHERE company_id=$1`, [cid]);
}
async function importWeb(entry, deps = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const f of [entry, ...deps]) fs.copyFileSync(path.join(__dirname, '..', 'web', f), path.join(dir, f));
  return import(pathToFileURL(path.join(dir, entry)).href);
}

before(H.start);
after(H.stop);

// ── Guard: provisioning is platform-admin only (admin.tenant.manage = R12) ───
test('provisioning is restricted to the platform admin; other roles are refused', async () => {
  const body = { name: 'Should Not Exist' };
  assert.equal((await H.req('POST', '/tenants', { token: await tok(F.USERS.EMP_A), body })).status, 403, 'employee (R01) refused');
  assert.equal((await H.req('POST', '/tenants', { token: await tok(F.USERS.DIRECTOR_A), body })).status, 403, 'Head of HR (R11) refused — privileged but not platform admin');
  // No stray tenant was created by the refused calls.
  assert.equal(Number((await owner(`SELECT count(*)::int n FROM tenant WHERE name=$1`, ['Should Not Exist'])).rows[0].n), 0);
});

// ── Provision through the endpoint; seeded from the registry ─────────────────
test('the wizard provisions a tenant through the endpoint, seeded from the registry', async () => {
  const admin = await tok(F.USERS.ADMIN_A); // R12
  const res = await H.req('POST', '/tenants', { token: admin, body: { name: 'F8 Mining Co' } });
  assert.equal(res.status, 200);
  const cid = res.body.company_id;
  try {
    assert.match(cid, /^[0-9a-f-]{36}$/i, 'a fresh companyId was minted server-side');
    assert.equal(res.body.config_keys, CONFIG_KEYS, 'whole registry seeded');
    assert.equal(res.body.sites, SITES);

    // The rows really landed, from the registry.
    assert.equal(Number((await owner(`SELECT count(*)::int n FROM config WHERE company_id=$1`, [cid])).rows[0].n), CONFIG_KEYS);
    assert.equal(Number((await owner(`SELECT count(*)::int n FROM site WHERE company_id=$1`, [cid])).rows[0].n), SITES);
    assert.equal(Number((await owner(`SELECT count(*)::int n FROM audit WHERE company_id=$1 AND action='tenant.provision'`, [cid])).rows[0].n), 1, 'audited as one genesis event');
  } finally {
    await purge(cid);
  }
});

// ── Atomic rollback: a mid-provision fault leaves nothing half-created ────────
test('a mid-provision fault rolls back atomically — nothing half-created', async () => {
  const admin = await tok(F.USERS.ADMIN_A);
  const beforeTenants = Number((await owner(`SELECT count(*)::int n FROM tenant`)).rows[0].n);
  const beforeConfig = Number((await owner(`SELECT count(*)::int n FROM config`)).rows[0].n);

  const faulted = await H.req('POST', '/tenants', { token: admin, body: { name: 'F8 Broken Co', faultStep: 'after_config' } });
  assert.notEqual(faulted.status, 200, 'faulted provision did not succeed');

  assert.equal(Number((await owner(`SELECT count(*)::int n FROM tenant`)).rows[0].n), beforeTenants, 'no tenant row survived the rollback');
  assert.equal(Number((await owner(`SELECT count(*)::int n FROM config`)).rows[0].n), beforeConfig, 'no config rows survived (even though the fault fired AFTER config insert)');
  assert.equal(Number((await owner(`SELECT count(*)::int n FROM tenant WHERE name=$1`, ['F8 Broken Co'])).rows[0].n), 0);
});

// ── Isolation: new tenant invisible to another tenant; caller untouched ──────
test('isolation: the provisioned tenant is invisible to another tenant; the caller is untouched', async () => {
  const admin = await tok(F.USERS.ADMIN_A);
  const aConfigBefore = Number((await owner(`SELECT count(*)::int n FROM config WHERE company_id=$1`, [A])).rows[0].n);

  const res = await H.req('POST', '/tenants', { token: admin, body: { name: 'F8 Isolated Co' } });
  const cid = res.body.company_id;
  try {
    // RLS: a session pinned to tenant A cannot see ANY of the new tenant's rows.
    const seen = await db.withTenant(A, (c) => c.query(`SELECT count(*)::int n FROM config WHERE company_id=$1`, [cid]));
    assert.equal(seen.rows[0].n, 0, 'tenant A cannot see the new tenant config (RLS holds through the provisioning path)');
    const seenSites = await db.withTenant(A, (c) => c.query(`SELECT count(*)::int n FROM site WHERE company_id=$1`, [cid]));
    assert.equal(seenSites.rows[0].n, 0, 'tenant A cannot see the new tenant sites');

    // The provisioning call did not touch the caller's own tenant.
    assert.equal(Number((await owner(`SELECT count(*)::int n FROM config WHERE company_id=$1`, [A])).rows[0].n), aConfigBefore, 'caller tenant A config unchanged');
  } finally {
    await purge(cid);
  }
});

// ── Render (C21 spec): the atomic-rollback state is DISTINCT from provisioned ─
test('wizard render: the rolled-back state is distinct from the provisioned state', async () => {
  const { provisionResultView } = await importWeb('tenant.js', ['api.js']);

  const ok = provisionResultView({ ok: true, tenant: { company_id: 'abc-123', name: 'X', config_keys: CONFIG_KEYS, sites: SITES } });
  assert.match(ok, /data-state="provisioned"/);
  assert.match(ok, /isolated/i, 'success view states the tenant is RLS-isolated');
  assert.doesNotMatch(ok, /data-state="rolled-back"/);

  const bad = provisionResultView({ ok: false, error: 'injected fault (test)' });
  assert.match(bad, /data-state="rolled-back"/, 'a failure renders the atomic-rollback state');
  assert.match(bad, /no tenant, config, or site was created/i, 'states nothing was half-created');
  assert.doesNotMatch(bad, /data-state="provisioned"/, 'rolled-back is NOT the provisioned state');
});
