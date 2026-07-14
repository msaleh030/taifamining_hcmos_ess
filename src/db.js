'use strict';
// Connection helpers built on the pure-JS client.
//
//   query(sql, params)        — one-off statement on the app role. Used ONLY to
//                               call SECURITY DEFINER auth-bootstrap functions
//                               (they enforce their own rules). No tenant data
//                               is read this way.
//   withTenant(companyId, fn) — the normal path for authenticated requests:
//                               opens a tx, pins app.company_id from the VERIFIED
//                               session, runs fn(client) under RLS, commits.
const { Pool, Client } = require('./pg');
const { APP, OWNER } = require('./dbconfig');

const appPool = new Pool(APP, 8);

// Optional SQL spy (tests only): records every statement run through the app
// role, so a test can assert e.g. that NO query touched employee_pay/medical on
// an out-of-site read (Section 17.2). No-op in production.
let _spy = null;
function setSpy(fn) { _spy = fn; }
function spied(client) {
  if (!_spy) return client;
  return { query: (sql, params) => { try { _spy(sql); } catch { /* ignore */ } return client.query(sql, params); } };
}

async function query(sql, params = []) {
  if (_spy) { try { _spy(sql); } catch { /* ignore */ } }
  const c = await appPool.acquire();
  try { return await c.query(sql, params); }
  finally { appPool.release(c); }
}

async function withTenant(companyId, fn) {
  const c = await appPool.acquire();
  try {
    await c.query('BEGIN');
    // set_config(..., is_local=true): scoped to this transaction only.
    await c.query('SELECT set_config($1,$2,true)', ['app.company_id', companyId]);
    const out = await fn(spied(c));
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    appPool.release(c);
  }
}

// Owner connection — migrations/seed only (bypasses RLS). Not used at runtime.
async function withOwner(fn) {
  const c = await new Client(OWNER).connect();
  try { return await fn(c); }
  finally { await c.end(); }
}

async function close() { await appPool.end(); }

module.exports = { query, withTenant, withOwner, close, appPool, setSpy };
