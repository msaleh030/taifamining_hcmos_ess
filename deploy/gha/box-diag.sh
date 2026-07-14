#!/usr/bin/env bash
# Read-only auth diagnostic for the UAT box — run ON THE RUNNER. Reproduces
# Kira's failing owner-role connection every way it can be made, printing only
# non-secret facts (var NAMES, lengths, OK/FAIL + error class — never values).
set -euo pipefail
: "${UAT_SSH_PRIVATE_KEY:?UAT_SSH_PRIVATE_KEY secret missing}"
IP="${UAT_BOX_IP:-152.239.121.249}"

install -d -m 700 ~/.ssh
printf '%s\n' "$UAT_SSH_PRIVATE_KEY" > ~/.ssh/uat_deploy
chmod 600 ~/.ssh/uat_deploy
if [ "$(wc -l < ~/.ssh/uat_deploy)" -le 2 ] && grep -q 'BEGIN OPENSSH PRIVATE KEY' ~/.ssh/uat_deploy; then
  sed -e 's/-----BEGIN OPENSSH PRIVATE KEY----- */-----BEGIN OPENSSH PRIVATE KEY-----\n/' \
      -e 's/ *-----END OPENSSH PRIVATE KEY-----/\n-----END OPENSSH PRIVATE KEY-----/' ~/.ssh/uat_deploy \
    | awk '/^-----/{print; next}{gsub(/ /,""); while (length($0) > 70) { print substr($0,1,70); $0 = substr($0,71) } if (length($0)) print}' \
    > ~/.ssh/uat_deploy.folded && mv ~/.ssh/uat_deploy.folded ~/.ssh/uat_deploy
  chmod 600 ~/.ssh/uat_deploy
fi

ssh -i ~/.ssh/uat_deploy -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "root@$IP" 'bash -s' <<'EOF'
set -uo pipefail
say() { printf '\n=== DIAG: %s ===\n' "$*"; }
ENVF=/etc/hcmos/hcmos.env

say "env file shape (names/lengths only)"
ls -l "$ENVF"
echo "CR characters in file: $(tr -cd '\r' < "$ENVF" | wc -c)"
echo "var names:"; cut -d= -f1 "$ENVF" | sed 's/^/  /'
set -a; . "$ENVF"; set +a
echo "PG_OWNER='${PG_OWNER:-<unset>}' pw length: ${#PG_OWNER_PW}"
echo "PGHOST=$PGHOST PGPORT=$PGPORT PGDATABASE=$PGDATABASE PGSSLMODE=$PGSSLMODE"

say "psql with the env password (TCP, scram)"
if PGPASSWORD="$PG_OWNER_PW" psql -h "$PGHOST" -p "$PGPORT" -U "$PG_OWNER" -d "$PGDATABASE" -Atc 'SELECT 1' >/dev/null 2>/tmp/diag.err; then
  echo "psql owner TCP: OK"
else
  echo "psql owner TCP: FAIL — $(head -1 /tmp/diag.err)"
fi
if PGPASSWORD="$PG_APP_PW" psql -h "$PGHOST" -p "$PGPORT" -U "$PG_APP" -d "$PGDATABASE" -Atc 'SELECT 1' >/dev/null 2>/tmp/diag.err; then
  echo "psql app   TCP: OK"
else
  echo "psql app   TCP: FAIL — $(head -1 /tmp/diag.err)"
fi

say "node vendored client, owner role — as root with env sourced"
cd /opt/hcmos
node -e "const db=require('./src/db');db.withOwner((c)=>c.query('SELECT 1')).then(()=>console.log('node owner (root+env): OK')).catch((e)=>console.log('node owner (root+env): FAIL —', e.message)).finally(()=>db.close());"

say "node vendored client, owner role — as the service user (deploy path)"
sudo -u hcmos -E env PATH="$PATH" node -e "const db=require('./src/db');db.withOwner((c)=>c.query('SELECT 1')).then(()=>console.log('node owner (hcmos+env): OK')).catch((e)=>console.log('node owner (hcmos+env): FAIL —', e.message)).finally(()=>db.close());"

say "hcmos-run wrapper"
if command -v hcmos-run >/dev/null; then
  hcmos-run node -e "const db=require('./src/db');db.withOwner((c)=>c.query('SELECT 1')).then(()=>console.log('node owner (hcmos-run): OK')).catch((e)=>console.log('node owner (hcmos-run): FAIL —', e.message)).finally(()=>db.close());"
else
  echo "hcmos-run NOT INSTALLED (wrapper deploy not landed?)"
fi

say "pg_hba host rules (method column — no secrets)"
HBA=$(sudo -u postgres psql -Atc 'SHOW hba_file')
grep -vE '^\s*#|^\s*$' "$HBA" | sed 's/^/  /'

say "role facts"
sudo -u postgres psql -Atc "SELECT rolname, rolcanlogin, (rolpassword IS NOT NULL) AS has_pw, left(coalesce(rolpassword,''),10) AS pw_prefix FROM pg_authid WHERE rolname IN ('hcmos_owner','hcmos_app')"

say "provision-super-admin dry probe (connect path only, no writes)"
UAT_COMPANY=11111111-1111-1111-1111-111111111111 node -e "
const db=require('./src/db');
db.withOwner((c)=>c.query('SELECT count(*) FROM app_user')).then((r)=>console.log('owner query via script env: OK')).catch((e)=>console.log('owner query via script env: FAIL —', e.message)).finally(()=>db.close());"
EOF
