#!/usr/bin/env node
// Apply db/schema.sql as the owner role via psql (handles dollar-quoted
// functions cleanly). Connection comes from env (see src/config-db.js defaults).
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { OWNER } = require('../src/dbconfig');

const schema = path.join(__dirname, '..', 'db', 'schema.sql');
try {
  execFileSync('psql', [
    '-v', 'ON_ERROR_STOP=1',
    '-h', OWNER.host, '-p', String(OWNER.port),
    '-U', OWNER.user, '-d', OWNER.database,
    '-f', schema,
  ], { stdio: 'inherit', env: { ...process.env, PGPASSWORD: OWNER.password || '' } });
  console.log('[migrate] schema applied');
} catch (e) {
  console.error('[migrate] failed');
  process.exit(1);
}
