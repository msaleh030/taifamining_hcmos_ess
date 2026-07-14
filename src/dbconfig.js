'use strict';
// Database connection settings.
//
// Local sandbox uses `trust` auth (see scripts/setup-db.sh) and sslmode=disable.
// Production sets PGSSLMODE=require|verify-full (+ PGSSLROOTCERT) so the same
// vendored client (src/pg.js) authenticates with SCRAM-SHA-256 over TLS. A full
// DATABASE_URL is also honoured for the application role.
const fs = require('node:fs');

const host = process.env.PGHOST || '127.0.0.1';
const port = Number(process.env.PGPORT || 5432);
const database = process.env.PGDATABASE || 'hcmos';
const ssl = process.env.PGSSLMODE || 'disable'; // disable|prefer|require|verify-ca|verify-full
const ca = process.env.PGSSLROOTCERT ? fs.readFileSync(process.env.PGSSLROOTCERT) : undefined;

// The application connects as the NON-superuser role so RLS is enforced.
let APP = {
  host, port, database, ssl, ca,
  user: process.env.PG_APP || 'hcmos_app',
  password: process.env.PG_APP_PW || 'hcmos_app_pw',
};

// Production override: a full connection URL for the app role.
if (process.env.DATABASE_URL) {
  const u = new URL(process.env.DATABASE_URL);
  APP = {
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.replace(/^\//, '') || database,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: u.searchParams.get('sslmode') || ssl,
    ca,
  };
}

// The owner role runs migrations/seeds and owns the SECURITY DEFINER functions.
const OWNER = {
  host, port, database, ssl, ca,
  user: process.env.PG_OWNER || 'hcmos_owner',
  password: process.env.PG_OWNER_PW || 'hcmos_owner_pw',
};

module.exports = { APP, OWNER };
