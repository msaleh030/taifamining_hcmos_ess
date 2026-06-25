'use strict';
// Database connection settings. Local `trust` auth (see scripts/setup-db.sh)
// means passwords are not actually checked, but we keep them for parity with
// non-sandbox environments.
const host = process.env.PGHOST || '127.0.0.1';
const port = Number(process.env.PGPORT || 5432);
const database = process.env.PGDATABASE || 'hcmos';

// The application connects as the NON-superuser role so RLS is enforced.
const APP = {
  host, port, database,
  user: process.env.PG_APP || 'hcmos_app',
  password: process.env.PG_APP_PW || 'hcmos_app_pw',
};

// The owner role runs migrations/seeds and owns the SECURITY DEFINER functions.
const OWNER = {
  host, port, database,
  user: process.env.PG_OWNER || 'hcmos_owner',
  password: process.env.PG_OWNER_PW || 'hcmos_owner_pw',
};

module.exports = { APP, OWNER };
