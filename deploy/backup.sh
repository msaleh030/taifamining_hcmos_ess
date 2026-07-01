#!/usr/bin/env bash
# Nightly Postgres backup for HCMOS → in-region object storage. UAT data is
# reloadable, but wiring this now means the same path carries to production.
# Driven by deploy/hcmos-backup.timer. Requires deploy/.env sourced (DB creds +
# BACKUP_TARGET) and rclone (or awscli) configured for an IN-REGION bucket.
set -euo pipefail

: "${PGDATABASE:=hcmos}"
: "${PG_OWNER:=hcmos_owner}"
: "${BACKUP_TARGET:?set BACKUP_TARGET (in-region object-storage remote, e.g. s3://bucket/pg)}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="/tmp/hcmos-${STAMP}.dump"

# Custom-format dump (compressed, restorable with pg_restore). Loopback, scram.
PGPASSWORD="${PG_OWNER_PW:?set PG_OWNER_PW}" pg_dump \
  -h 127.0.0.1 -U "${PG_OWNER}" -d "${PGDATABASE}" -F c -f "${FILE}"

# Ship to in-region object storage (rclone shown; swap for `aws s3 cp` if preferred).
rclone copyto "${FILE}" "${BACKUP_TARGET}/hcmos-${STAMP}.dump"
rm -f "${FILE}"

# Retention: keep 14 nightly dumps.
rclone delete --min-age 14d "${BACKUP_TARGET}" || true
echo "[backup] hcmos-${STAMP}.dump → ${BACKUP_TARGET}"

# RESTORE TEST (D-5), run once by hand to prove the backup is usable:
#   createdb hcmos_restore_test
#   pg_restore -h 127.0.0.1 -U "${PG_OWNER}" -d hcmos_restore_test hcmos-<STAMP>.dump
#   # sanity-check row counts, then dropdb hcmos_restore_test
