#!/usr/bin/env bash
# Reproducible local Postgres setup for HCMOS ESS — Slice 1.
#
# Creates the `hcmos` database, an owner role (runs migrations, owns the tables)
# and a NON-superuser application role (`hcmos_app`). The app connects as the
# non-superuser role so Row Level Security is genuinely enforced — superusers
# and table owners bypass RLS, a non-owner role does not.
#
# Local TCP `trust` auth is configured for the two HCMOS roles only, so the
# pure-Node Postgres client does not need to implement SCRAM. This is a
# sandbox/dev convenience; production uses scram-sha-256 + real secrets.
#
# Idempotent: safe to run repeatedly.
set -euo pipefail

PG_VER="${PG_VER:-16}"
PG_CLUSTER="${PG_CLUSTER:-main}"
DB_NAME="${PGDATABASE:-hcmos}"
OWNER_ROLE="${PG_OWNER:-hcmos_owner}"
APP_ROLE="${PG_APP:-hcmos_app}"
OWNER_PW="${PG_OWNER_PW:-hcmos_owner_pw}"
APP_PW="${PG_APP_PW:-hcmos_app_pw}"

say() { printf '\033[1;34m[setup-db]\033[0m %s\n' "$*"; }

# 1. Ensure the cluster is running.
if ! pg_lsclusters -h 2>/dev/null | awk '{print $4}' | grep -q online; then
  say "starting PostgreSQL ${PG_VER}/${PG_CLUSTER}"
  pg_ctlcluster "$PG_VER" "$PG_CLUSTER" start || true
fi

PSQL() { sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"; }

# 2. Roles (idempotent).
say "ensuring roles ${OWNER_ROLE} / ${APP_ROLE}"
PSQL -tc "SELECT 1 FROM pg_roles WHERE rolname='${OWNER_ROLE}'" | grep -q 1 || \
  PSQL -c "CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD '${OWNER_PW}'"
PSQL -tc "SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}'" | grep -q 1 || \
  PSQL -c "CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PW}'"
# Belt and braces: the app role must never bypass RLS.
PSQL -c "ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"

# 3. Database owned by the owner role.
PSQL -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  PSQL -c "CREATE DATABASE ${DB_NAME} OWNER ${OWNER_ROLE}"

# 3b. Extensions (require superuser, so provisioned here not in app migrations):
#     pg_trgm powers indexed substring search on the employee directory at scale.
say "ensuring extensions (pg_trgm, btree_gin)"
PSQL -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null
PSQL -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS btree_gin" >/dev/null

# 4. Local trust auth for the two HCMOS roles (so the JS client skips SCRAM).
HBA="$(PSQL -tA -c 'SHOW hba_file')"
MARKER="# >>> hcmos trust (managed by setup-db.sh) >>>"
if ! sudo grep -qF "$MARKER" "$HBA"; then
  say "adding local trust rules to ${HBA}"
  TMP="$(mktemp)"
  {
    echo "$MARKER"
    echo "host    ${DB_NAME}    ${APP_ROLE}      127.0.0.1/32   trust"
    echo "host    ${DB_NAME}    ${OWNER_ROLE}    127.0.0.1/32   trust"
    echo "host    ${DB_NAME}    ${APP_ROLE}      ::1/128        trust"
    echo "host    ${DB_NAME}    ${OWNER_ROLE}    ::1/128        trust"
    echo "# <<< hcmos trust <<<"
    sudo cat "$HBA"
  } > "$TMP"
  sudo cp "$TMP" "$HBA"
  rm -f "$TMP"
  PSQL -c "SELECT pg_reload_conf()" >/dev/null
fi

say "ready: postgresql://${APP_ROLE}@127.0.0.1:5432/${DB_NAME}"
