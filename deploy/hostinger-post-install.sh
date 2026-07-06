#!/usr/bin/env bash
# Hostinger VPS post-install for HCMOS/ESS UAT. Paste into the VPS "post-install
# script" field (runs once after provision; logs to /post_install.log, 48 KB max)
# OR run by hand as root on a fresh Ubuntu box. Reproducible: re-running is safe.
#
# Sets up the FULL hardened stack: Node LTS + Postgres 16 (scram, localhost-only,
# REAL generated secrets — never the sandbox trust/seed values), clones the repo at
# a CI-green commit, migrates + seeds scaffolding, runs the app under systemd, and
# wires nightly backups. Cloudflare Tunnel/Access/DNS is done in YOUR Cloudflare
# account afterwards (see deploy/cloudflare-edge.md) — it needs your login, not this
# box. The real 340-balance + permit data load is a follow-up (drop the files, load
# via the ingestion path).
set -euo pipefail
exec > >(tee -a /post_install.log) 2>&1
echo "[post-install] $(date -u) starting"

# --- Parameters (edit before pasting) ---------------------------------------
REPO_URL="${REPO_URL:-https://github.com/msaleh030/taifamining_hcmos_ess.git}"
REPO_REF="${REPO_REF:-claude/nifty-goodall-poihi4}"   # deploy from a KNOWN-GREEN commit/branch
APP_DIR=/opt/hcmos
SVC_USER=hcmos
ENV_FILE=/etc/hcmos/hcmos.env

# --- 1. Base packages -------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get -y upgrade
apt-get install -y curl ca-certificates gnupg git ufw rclone

# Node LTS (NodeSource) + PostgreSQL 16 (PGDG, so the major is fixed regardless of
# the Ubuntu release) + contrib (pg_trgm / btree_gin).
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release; echo "$VERSION_CODENAME")-pgdg main" > /etc/apt/sources.list.d/pgdg.list
apt-get update
apt-get install -y nodejs postgresql-16 postgresql-contrib-16

# --- 2. Firewall: deny inbound except SSH; 443 only if NOT using a tunnel ----
ufw --force reset
ufw default deny incoming; ufw default allow outgoing
ufw allow 22/tcp           # tighten to known RailGrid IPs: ufw allow from <IP> to any port 22
# With a Cloudflare Tunnel, do NOT open 443 (the tunnel dials out). If using a
# public IP + reverse proxy instead, uncomment:  ufw allow 443/tcp
ufw --force enable

# --- 3. Service user + source ------------------------------------------------
# LOCAL_SRC=1: the source (incl. the CI-built enforced frontend/dist) was shipped
# as a tarball by the GitHub Actions deploy (the repo is private — no anonymous
# clone). Without it, classic clone mode for hand-runs with a reachable repo.
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SVC_USER"
install -d -o "$SVC_USER" -g "$SVC_USER" "$APP_DIR"
if [ "${LOCAL_SRC:-0}" != "1" ]; then
  if [ ! -d "$APP_DIR/.git" ]; then sudo -u "$SVC_USER" git clone "$REPO_URL" "$APP_DIR"; fi
  cd "$APP_DIR"
  sudo -u "$SVC_USER" git fetch --all --quiet
  sudo -u "$SVC_USER" git checkout "$REPO_REF"
  sudo -u "$SVC_USER" git pull --ff-only || true
fi
cd "$APP_DIR"
sudo -u "$SVC_USER" npm install --no-audit --no-fund

# --- 4. Secrets: GENERATE strong values into the EnvironmentFile (600) -------
# Never printed, never committed. The app + DB talk over localhost, so these never
# leave the box. Rotate later via your secret store if desired.
install -d -m 700 /etc/hcmos
if [ ! -f "$ENV_FILE" ]; then
  OWNER_PW="$(openssl rand -base64 24)"; APP_PW="$(openssl rand -base64 24)"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=hcmos
PGSSLMODE=disable
PG_OWNER=hcmos_owner
PG_OWNER_PW=${OWNER_PW}
PG_APP=hcmos_app
PG_APP_PW=${APP_PW}
BACKUP_TARGET=
EOF
  chmod 600 "$ENV_FILE"
fi
set -a; . "$ENV_FILE"; set +a

# --- 5. Hardened DB (scram, no trust, localhost) + schema + scaffolding ------
bash deploy/setup-db.prod.sh
sudo -u "$SVC_USER" -E env PATH="$PATH" node scripts/migrate.js
sudo -u "$SVC_USER" -E env PATH="$PATH" node scripts/seed.js
# DATA LOAD (test data — 340 balances + permits): a FOLLOW-UP. Drop the files on the
# box and load them through the ingestion path (deploy/README.md §3); the app now
# defaults to the seed's synthetic directory until then.

# --- 6. App under systemd (restart-on-failure) ------------------------------
install -m 644 deploy/hcmos.service /etc/systemd/system/hcmos.service
install -m 644 deploy/hcmos-backup.service /etc/systemd/system/hcmos-backup.service
install -m 644 deploy/hcmos-backup.timer   /etc/systemd/system/hcmos-backup.timer
systemctl daemon-reload
systemctl enable --now hcmos
# Enable the nightly backup timer once BACKUP_TARGET is set (rclone remote):
# systemctl enable --now hcmos-backup.timer

echo "[post-install] done. Node on 127.0.0.1:3000 under systemd; Postgres scram+localhost."
echo "NEXT (your Cloudflare account): cloudflared tunnel -> localhost:3000, Access allow-list,"
echo "DNS uat.taifamining.tz, cache bypass for the API. See deploy/cloudflare-edge.md."
echo "THEN: provision UAT users (scripts/provision-uat-user.js) and load the 340-row test data."
