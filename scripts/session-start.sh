#!/usr/bin/env bash
# SessionStart hook: make the repo immediately testable in a fresh Claude Code
# (web) session. Brings up Postgres, applies the schema, and seeds fixtures so
# `npm test` works without manual setup. Idempotent and quiet on success.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/setup-db.sh >/dev/null 2>&1 || { echo "[session-start] db setup failed" >&2; exit 0; }
node scripts/migrate.js >/dev/null 2>&1 || true
node scripts/seed.js >/dev/null 2>&1 || true
echo "[session-start] HCMOS auth DB ready (db=hcmos, role=hcmos_app)"
