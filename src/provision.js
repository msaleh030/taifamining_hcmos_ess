'use strict';
// Slice 10 — Tenant provisioning wizard (C21, TEN-01/02/03).
//
// Creates a tenant with its own company_id and seeds everything a tenant needs
// FROM THE REGISTRY — no manual DB step and no values duplicated into the wizard:
//   - config: the whole DEFAULT_CONFIG registry (LOC codes, leave types/params,
//     document types + DA-1 lead times + DA-2 notify roles, statutory params,
//     the analytics flag, …). A value corrected in the registry (e.g. the DA-2
//     roles) therefore flows to every new tenant automatically.
//   - sites: one per enabled LOC code, derived from empno.locations (registry).
// Roles R01-R13, the permission/action matrix and the KPI catalogue+targets are
// GLOBAL code (src/roles.js, src/kpi.js) — a single source that applies to every
// tenant, so they are not duplicated per tenant.
//
// The whole thing is ONE owner transaction: any failure rolls back the entire
// tenant (no half-provisioned company), and it is audited as a single event
// (the genesis of the tenant's audit chain).
const db = require('./db');
const { DEFAULT_CONFIG } = require('./config');
const { parseLocations } = require('./empno');
const { HttpError } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// opts.faultStep (TEST ONLY) forces a throw mid-provision to prove atomicity.
async function provisionTenant({ companyId, name, actor = 'system', role = 'SYS' }, opts = {}) {
  if (!UUID_RE.test(String(companyId || ''))) throw new HttpError(400, 'valid companyId required');
  if (!name) throw new HttpError(400, 'name required');

  return db.withOwner(async (c) => {
    try {
      await c.query('BEGIN');

      // 1. the tenant itself
      await c.query('INSERT INTO tenant(company_id,name,status) VALUES ($1,$2,$3)', [companyId, name, 'active']);

      // 2. config — seeded straight from the registry (no duplication)
      for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
        await c.query('INSERT INTO config(company_id,key,value) VALUES ($1,$2,$3)', [companyId, key, value]);
      }
      if (opts.faultStep === 'after_config') throw new Error('injected fault (test)');

      // 3. sites — one per ENABLED LOC code, from the registry's empno.locations
      const locations = parseLocations(DEFAULT_CONFIG['empno.locations']);
      const codes = [...locations.values()].filter(Boolean); // skip blocked (empty) codes
      for (const code of codes) {
        await c.query('INSERT INTO site(company_id,name) VALUES ($1,$2)', [companyId, code]);
      }

      // 4. one audit event — genesis of this tenant's chain
      await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
        companyId, actor, role, 'tenant.provision', 'tenant', companyId, null,
        { name, config_keys: Object.keys(DEFAULT_CONFIG).length, sites: codes.length }]);

      await c.query('COMMIT');
      return { company_id: companyId, name, config_keys: Object.keys(DEFAULT_CONFIG).length, sites: codes.length };
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  });
}

module.exports = { provisionTenant };
