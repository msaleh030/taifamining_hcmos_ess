'use strict';
// The vendored Postgres client must be production-capable: SCRAM-SHA-256 auth
// and TLS, not just local trust. SCRAM is asserted against the real server (the
// default pg_hba scram-sha-256 line applies to non-hcmos databases). TLS is
// asserted only when the server has SSL enabled, otherwise skipped — server SSL
// is a deploy/DBA concern, not part of the app's setup.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('../src/pg');
const { APP } = require('../src/dbconfig');

const base = { host: APP.host, port: APP.port, user: APP.user, password: APP.password };

test('SCRAM-SHA-256: correct password authenticates', async () => {
  const c = await new Client({ ...base, database: 'postgres', ssl: 'disable' }).connect();
  const r = await c.query('SELECT current_user AS u');
  assert.equal(r.rows[0].u, base.user);
  await c.end();
});

test('SCRAM-SHA-256: wrong password is rejected', async () => {
  await assert.rejects(
    new Client({ ...base, database: 'postgres', password: 'definitely-wrong', ssl: 'disable' }).connect(),
    /password authentication failed/i);
});

test('TLS: sslmode=require negotiates an encrypted connection (when server SSL is on)', async (t) => {
  let c;
  try {
    c = await new Client({ ...base, database: 'postgres', ssl: 'require' }).connect();
  } catch (e) {
    if (/does not support SSL/i.test(e.message)) return t.skip('server SSL disabled in this environment');
    throw e;
  }
  const r = await c.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
  assert.equal(r.rows[0].ssl, true, 'backend reports an encrypted connection');
  await c.end();
});
