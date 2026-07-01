#!/usr/bin/env bash
# HARDENED Postgres setup for a DEPLOYED HCMOS instance (UAT or production).
#
# This is the deploy-grade replacement for scripts/setup-db.sh, which uses local
# `trust` auth for sandbox convenience ONLY. Here:
#   • authentication is scram-sha-256 (NO trust anywhere);
#   • role passwords come from the environment/secret store — NEVER defaulted;
#   • the cluster binds to localhost only (Postgres is never publicly reachable);
#   • the application role is a non-superuser with NOBYPASSRLS so RLS is enforced.
#
# Run once on the origin box (in-region — af-south-1 per the DPA/registry). Secrets
# are read from the environment; source deploy/.env first (chmod 600, not in git).
set -euo pipefail

: "${PG_OWNER_PW:?set PG_OWNER_PW (owner role password) — no default in a deployment}"
: "${PG_APP_PW:?set PG_APP_PW (app role password) — no default in a deployment}"
PG_VER="${PG_VER:-16}"
PG_CLUSTER="${PG_CLUSTER:-main}"
DB_NAME="${PGDATABASE:-hcmos}"
OWNER_ROLE="${PG_OWNER:-hcmos_owner}"
APP_ROLE="${PG_APP:-hcmos_app}"

say() { printf '\033[1;34m[setup-db.prod]\033[0m %s\n' "$*"; }
PSQL() { sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"; }

# 1. scram-sha-256 for all new/updated passwords + localhost-only listening.
say "enforcing scram-sha-256 and localhost-only binding"
PSQL -c "ALTER SYSTEM SET password_encryption = 'scram-sha-256'"
PSQL -c "ALTER SYSTEM SET listen_addresses = 'localhost'"    # never 0.0.0.0
PSQL -c "SELECT pg_reload_conf()" >/dev/null

# 2. Roles with REAL secrets (passwords set AFTER scram is the encryption).
say "ensuring roles ${OWNER_ROLE} / ${APP_ROLE} with scram passwords"
PSQL -tc "SELECT 1 FROM pg_roles WHERE rolname='${OWNER_ROLE}'" | grep -q 1 \
  && PSQL -c "ALTER ROLE ${OWNER_ROLE} LOGIN PASSWORD '${PG_OWNER_PW}'" \
  || PSQL -c "CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD '${PG_OWNER_PW}'"
PSQL -tc "SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}'" | grep -q 1 \
  && PSQL -c "ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${PG_APP_PW}'" \
  || PSQL -c "CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${PG_APP_PW}'"
PSQL -c "ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"

# 3. Database + extensions (superuser-only, so here not in app migrations).
PSQL -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || PSQL -c "CREATE DATABASE ${DB_NAME} OWNER ${OWNER_ROLE}"
PSQL -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null
PSQL -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS btree_gin" >/dev/null

# 4. pg_hba: scram-sha-256 for the two roles on loopback ONLY. Explicitly assert
#    that NO `trust` line exists (fail hard if the sandbox script ever ran here).
HBA="$(PSQL -tA -c 'SHOW hba_file')"
if sudo grep -E '^[^#].*\btrust\b' "$HBA" >/dev/null; then
  say "REFUSING TO PROCEED: a 'trust' auth line exists in ${HBA} — remove it (deploy must be scram only)"
  exit 1
fi
MARKER="# >>> hcmos scram (managed by setup-db.prod.sh) >>>"
if ! sudo grep -qF "$MARKER" "$HBA"; then
  say "adding loopback scram-sha-256 rules to ${HBA}"
  TMP="$(mktemp)"
  {
    echo "$MARKER"
    echo "host    ${DB_NAME}    ${APP_ROLE}      127.0.0.1/32   scram-sha-256"
    echo "host    ${DB_NAME}    ${OWNER_ROLE}    127.0.0.1/32   scram-sha-256"
    echo "host    ${DB_NAME}    ${APP_ROLE}      ::1/128        scram-sha-256"
    echo "host    ${DB_NAME}    ${OWNER_ROLE}    ::1/128        scram-sha-256"
    echo "# <<< hcmos scram <<<"
    sudo cat "$HBA"
  } > "$TMP"
  sudo cp "$TMP" "$HBA"; rm -f "$TMP"
  PSQL -c "SELECT pg_reload_conf()" >/dev/null
fi

say "ready: the app connects as ${APP_ROLE} over loopback with scram-sha-256."
say "app env must set PG_APP_PW + PGSSLMODE (require|verify-full) — never trust, never public."
