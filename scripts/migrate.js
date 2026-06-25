#!/usr/bin/env node
'use strict';
// Versioned, additive migration runner. Applies each db/migrations/NNN_*.sql
// exactly once, in order, recording it in schema_migrations with a checksum.
// Each file runs in a single transaction (psql -1); a failed migration aborts
// without recording. NEVER drops data — Slice 1's destructive schema is gone.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { OWNER } = require('../src/dbconfig');

const dir = path.join(__dirname, '..', 'db', 'migrations');
const env = { ...process.env, PGPASSWORD: OWNER.password || '' };
const base = ['-v', 'ON_ERROR_STOP=1', '-h', OWNER.host, '-p', String(OWNER.port),
  '-U', OWNER.user, '-d', OWNER.database];

function psqlCmd(sql) {
  return execFileSync('psql', [...base, '-tAc', sql], { env }).toString().trim();
}
function psqlFile(file) {
  // -1 wraps the whole file in one transaction.
  execFileSync('psql', [...base, '-1', '-f', file], { stdio: 'inherit', env });
}

function main() {
  psqlCmd(`CREATE TABLE IF NOT EXISTS schema_migrations(
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);

  const applied = new Set(psqlCmd('SELECT version FROM schema_migrations').split('\n').filter(Boolean));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  let ran = 0;
  for (const f of files) {
    const version = f.replace(/\.sql$/, '');
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    const checksum = crypto.createHash('sha256').update(body).digest('hex');
    if (applied.has(version)) continue;

    // Append the ledger insert so file + record commit atomically in the -1 tx.
    const tmp = path.join(os.tmpdir(), `mig_${version}.sql`);
    fs.writeFileSync(tmp,
      body + `\nINSERT INTO schema_migrations(version,checksum) VALUES ('${version}','${checksum}');\n`);
    console.log(`[migrate] applying ${version}`);
    psqlFile(tmp);
    fs.unlinkSync(tmp);
    ran++;
  }
  console.log(ran ? `[migrate] ${ran} migration(s) applied` : '[migrate] up to date');
}

try { main(); } catch (e) { console.error('[migrate] failed'); process.exit(1); }
