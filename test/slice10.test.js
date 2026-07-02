'use strict';
// Slice 10 — Tenant provisioning wizard (C21, TEN-01/02/03). Atomic, audited,
// seeded entirely from the registry; a second tenant proves full data isolation
// at the provisioning layer. Runs after section17 (its audit-intact check already
// ran); test tenants are cleaned up at the end.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const provision = require('../src/provision');
const cfg = require('../src/config');
const { DEFAULT_CONFIG } = require('../src/config');
const { parseLocations } = require('../src/empno');

const T1 = '99990000-0000-0000-0000-000000000001';
const T2 = '99990000-0000-0000-0000-000000000002';
const T3 = '99990000-0000-0000-0000-000000000003';
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const KEYS = Object.keys(DEFAULT_CONFIG).length;
const LOC_CODES = [...parseLocations(DEFAULT_CONFIG['empno.locations']).values()].filter(Boolean);

before(H.start);
after(H.stop);

// ── TEN-01: provision a tenant entirely from the registry, audited as one event ─
test('TEN-01 provisions a tenant from the registry (config, LOC sites) audited as one event', async () => {
  const res = await provision.provisionTenant({ companyId: T1, name: 'Alpha Mining' });
  assert.equal(res.company_id, T1);

  assert.equal((await owner(`SELECT status FROM tenant WHERE company_id=$1`, [T1])).rows[0].status, 'active');

  // config seeded from the registry — EVERY key/value equals DEFAULT_CONFIG (not
  // hard-coded in the wizard), incl. the corrected DA-2 roles + DA-1 lead times.
  const rows = (await owner(`SELECT key, value FROM config WHERE company_id=$1`, [T1])).rows;
  assert.equal(rows.length, KEYS, 'all registry keys seeded');
  const got = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) assert.equal(got[k], v, `registry value flows: ${k}`);

  // The COMPLETE DA-2 notify set resolves in the fresh tenant (not just one type).
  const DA2 = { contract: 'R05', permit: 'R06', licence: 'R06', medical: 'R03' };
  for (const [kind, role] of Object.entries(DA2)) {
    assert.equal(got[`doc.notify.role.${kind}`], role, `DA-2 ${kind} → ${role} in the provisioned tenant`);
    assert.equal(await cfg.getConfig(T1, `doc.notify.role.${kind}`), role, `DA-2 ${kind} resolves via the registry reader`);
  }

  // sites created from the registry LOC codes.
  const sites = (await owner(`SELECT name FROM site WHERE company_id=$1`, [T1])).rows.map((r) => r.name).sort();
  assert.deepEqual(sites, LOC_CODES.slice().sort());

  // audited as ONE event, the genesis of this tenant's chain.
  const aud = (await owner(`SELECT prev_hash FROM audit WHERE company_id=$1 AND action='tenant.provision'`, [T1])).rows;
  assert.equal(aud.length, 1);
  assert.equal(aud[0].prev_hash, '0'.repeat(64), 'genesis prev_hash');
});

// ── TEN-02: atomic — a mid-provision failure rolls back the whole tenant ─────
test('TEN-02 provisioning is atomic — a failure leaves no half-provisioned company', async () => {
  await assert.rejects(
    provision.provisionTenant({ companyId: T3, name: 'Broken Co' }, { faultStep: 'after_config' }),
    /injected fault/);
  for (const tbl of ['tenant', 'config', 'site']) {
    const n = (await owner(`SELECT count(*)::int n FROM ${tbl} WHERE company_id=$1`, [T3])).rows[0].n;
    assert.equal(n, 0, `${tbl} rolled back`);
  }
});

// ── TEN-03: repeatable — provision a second tenant, prove full isolation ─────
test('TEN-03 a second tenant is fully isolated from the first (provisioning-layer proof)', async () => {
  try {
    await provision.provisionTenant({ companyId: T2, name: 'Beta Mining' });
    // both fully provisioned, independently (repeatable).
    assert.equal((await owner(`SELECT count(*)::int n FROM config WHERE company_id=$1`, [T2])).rows[0].n, KEYS);

    // RLS at the app layer: T1 sees only T1; a crafted cross-tenant query returns nothing.
    await db.withTenant(T1, async (c) => {
      assert.equal((await c.query('SELECT count(*)::int n FROM site')).rows[0].n, LOC_CODES.length, 'sees only its own sites');
      assert.equal((await c.query('SELECT count(*)::int n FROM site WHERE company_id=$1', [T2])).rows[0].n, 0, 'cannot see T2 sites');
      assert.equal((await c.query('SELECT count(*)::int n FROM config WHERE company_id=$1', [T2])).rows[0].n, 0, 'cannot see T2 config');
    });
    await db.withTenant(T2, async (c) => {
      assert.equal((await c.query('SELECT count(*)::int n FROM site WHERE company_id=$1', [T1])).rows[0].n, 0, 'cannot see T1 sites');
    });

    // Independent config: changing T2's registry value does not touch T1's.
    await owner(`UPDATE config SET value='disable' WHERE company_id=$1 AND key='geofence.empty_zone.policy'`, [T2]);
    assert.equal(await cfg.getConfig(T1, 'geofence.empty_zone.policy'), DEFAULT_CONFIG['geofence.empty_zone.policy']);
    assert.equal(await cfg.getConfig(T2, 'geofence.empty_zone.policy'), 'disable');
  } finally {
    for (const t of [T1, T2]) {
      await owner(`DELETE FROM config WHERE company_id=$1`, [t]);
      await owner(`DELETE FROM site WHERE company_id=$1`, [t]);
      await owner(`DELETE FROM tenant WHERE company_id=$1`, [t]);
    }
  }
});
