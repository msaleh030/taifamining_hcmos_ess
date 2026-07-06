#!/usr/bin/env bash
# Runs ON THE UAT BOX as root (piped over SSH by deploy-uat.sh). Idempotent.
# Stack per GO.md: hardened Postgres (scram/localhost/non-superuser app role),
# app at the shipped ENFORCED build under systemd, v1.6 named users with
# credentials written ONLY to /root/uat-credentials.txt (600), backups + a real
# restore test, smoke test, and the confidentiality acceptance probe (R03 vs
# pay-entitled) run ON-BOX so no credential ever reaches a CI log.
set -euo pipefail
say() { printf '\n=== BOX CHECKPOINT: %s ===\n' "$*"; }
APP_DIR=/opt/hcmos
CREDS=/root/uat-credentials.txt
UAT_CO=11111111-1111-1111-1111-111111111111

# ── source in place (tarball shipped by the runner; no clone — repo is private)
say "unpack source + enforced dist"
apt-get update -qq && apt-get install -y -qq rsync >/dev/null
TMP=$(mktemp -d)
tar -xzf /root/hcmos-src.tgz -C "$TMP"
id hcmos >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin hcmos
install -d -o hcmos -g hcmos "$APP_DIR"
rsync -a --delete --chown=hcmos:hcmos "$TMP/hcmos/" "$APP_DIR/"
rm -rf "$TMP" /root/hcmos-src.tgz
DEPLOY_REF=$(cd "$APP_DIR" && (git rev-parse --short HEAD 2>/dev/null || echo 'tarball'))
echo "deployed ref: $DEPLOY_REF (tarball of the CI-enforced head; dist included: $(test -f $APP_DIR/frontend/dist/index.html && echo yes || echo NO))"

# ── base stack + hardened DB + app service (LOCAL_SRC: no clone) ─────────────
say "post-install (Node LTS, Postgres 16, UFW, scram, systemd)"
cd "$APP_DIR"
LOCAL_SRC=1 bash deploy/hostinger-post-install.sh

set -a; . /etc/hcmos/hcmos.env; set +a

# ── cloudflared (only if the token was staged) ────────────────────────────────
if [ -f /etc/cloudflared/env ]; then
  say "cloudflared tunnel service (zero inbound 443)"
  if ! command -v cloudflared >/dev/null; then
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(. /etc/os-release; echo "$VERSION_CODENAME") main" > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -qq && apt-get install -y -qq cloudflared
  fi
  . /etc/cloudflared/env
  cloudflared service install "$TUNNEL_TOKEN" 2>/dev/null || systemctl restart cloudflared || true
  systemctl is-active cloudflared && echo "cloudflared active (route uat.taifamining.tz -> this tunnel in the Cloudflare dashboard + Access policy per deploy/cloudflare-edge.md)"
else
  echo "cloudflared skipped (no token) — edge is a Kira-side step"
fi

# ── v1.6 users: named accounts now; SoD maker/checker on DISTINCT accounts ───
say "provision v1.6 named users (credentials -> $CREDS, 600, on-box only)"
touch "$CREDS" && chmod 600 "$CREDS"
HQ_SITE=$(sudo -u postgres psql -d hcmos -Atc "SELECT name FROM site WHERE company_id='$UAT_CO' AND lower(name) LIKE '%head%' LIMIT 1")
HQ_SITE=${HQ_SITE:-$(sudo -u postgres psql -d hcmos -Atc "SELECT name FROM site WHERE company_id='$UAT_CO' LIMIT 1")}
ANY_SITE=$(sudo -u postgres psql -d hcmos -Atc "SELECT name FROM site WHERE company_id='$UAT_CO' AND lower(name) NOT LIKE '%head%' LIMIT 1")
ANY_SITE=${ANY_SITE:-$HQ_SITE}
echo "sites: HQ='$HQ_SITE' probe-site='$ANY_SITE'"

prov() { # email name role site
  local email="$1" name="$2" role="$3" site="$4"
  if sudo -u postgres psql -d hcmos -Atc "SELECT 1 FROM app_user WHERE company_id='$UAT_CO' AND lower(email)=lower('$email')" | grep -q 1; then
    echo "exists: $email ($role)"; return 0
  fi
  UAT_COMPANY="$UAT_CO" UAT_EMAIL="$email" UAT_NAME="$name" UAT_ROLE="$role" UAT_SITE="$site" \
    node scripts/provision-uat-user.js >> "$CREDS" 2>&1 \
    && echo "provisioned: $email ($role, $site)" || { echo "FAILED: $email ($role)"; return 1; }
}

# REVISED v1.6 roster (Kira): SoD on two dedicated people, NO +alias accounts —
# Omar Omar is the R15 maker, Viswa Medhuru the R16 checker; Omid is R11 only,
# Cecilia R07 only. Rajesh (R12) + the two super admins are UNSCOPED.
prov omid.karambeck@taifamining.tz  'Omid Karambeck' R11 "$HQ_SITE"
prov cecilia.mtweve@taifamining.tz  'Cecilia Mtweve' R07 "$HQ_SITE"
prov omar.omar@taifamining.tz       'Omar Omar'      R15 "$HQ_SITE"
prov viswa.medhuru@taifamining.tz   'Viswa Medhuru'  R16 "$HQ_SITE"
# R12 is UNSCOPED by role config (site_scope.R12=false) — the home site below is
# only the employee record's anchor; his visibility is All Sites by role.
prov rajesh.chohan@taifamining.tz   'Rajesh Chohan'  R12 "$HQ_SITE"
# Acceptance-probe R03 (temporary, clearly named; replaced when Taifa HR sends
# the four HR Officer names):
prov uat.probe.r03@taifamining.tz   'UAT Probe (HR Officer)' R03 "$ANY_SITE"
echo "PENDING NAMES (provision when Taifa HR confirms): 4x R03, 2x R04, maurice.<surname> R06, richard.<surname> R14"
echo "SUPER ADMINS (interactive, hidden password — Kira runs on this box):" | tee -a "$CREDS"
echo "  UAT_COMPANY=$UAT_CO node scripts/provision-super-admin.js mohammed@railgrid.tz" | tee -a "$CREDS"
echo "  UAT_COMPANY=$UAT_CO node scripts/provision-super-admin.js admin@taifamining.tz" | tee -a "$CREDS"

# ── data load: gated on the files being dropped ───────────────────────────────
say "data load (838 leave records + North Mara payroll + permits)"
if ls /root/uat-data/*.csv >/dev/null 2>&1; then
  echo "found /root/uat-data — load via: node scripts/load-ingest.js ... (see deploy/GO.md §7, maker cecilia+finance / checker omid+cfc)"
else
  echo "AWAITING DATA DROP: no /root/uat-data/*.csv on the box. Seeded scaffolding is live;"
  echo "drop Baraka's files + control.json and run GO.md §7 (loads through the audited ingestion path)."
fi

# ── backups + ONE tested restore ──────────────────────────────────────────────
say "backups (nightly timer) + restore test"
install -d -m 700 /var/backups/hcmos
systemctl enable --now hcmos-backup.timer 2>/dev/null || echo "timer not enabled (set BACKUP_TARGET for off-box; local dump follows)"
DUMP=/var/backups/hcmos/manual-$(date -u +%Y%m%d).dump
sudo -u postgres pg_dump -Fc hcmos > "$DUMP"
sudo -u postgres dropdb --if-exists hcmos_restore_test
sudo -u postgres createdb hcmos_restore_test
# /var/backups/hcmos is root-owned 700, so the postgres user cannot open the
# dump path itself — feed it via stdin (root's shell opens the file). Keep the
# restore's stderr so a failed round-trip is diagnosable, not silent.
sudo -u postgres pg_restore -d hcmos_restore_test --no-owner --role=postgres < "$DUMP" 2>/root/restore-test.err || true
RESTORED=$(sudo -u postgres psql -d hcmos_restore_test -Atc "SELECT count(*) FROM employee" 2>/dev/null || echo 0)
ORIG=$(sudo -u postgres psql -d hcmos -Atc "SELECT count(*) FROM employee")
sudo -u postgres dropdb hcmos_restore_test
if [ "$RESTORED" = "$ORIG" ] && [ "$ORIG" -gt 0 ]; then
  echo "RESTORE TEST PASS: $RESTORED/$ORIG employee rows round-tripped"
  rm -f /root/restore-test.err
else
  echo "RESTORE TEST FAIL: restored=$RESTORED original=$ORIG — pg_restore stderr tail:"
  tail -20 /root/restore-test.err 2>/dev/null || echo "(no stderr captured)"
  exit 1
fi

# ── smoke test ────────────────────────────────────────────────────────────────
say "smoke test"
bash deploy/smoke-test.sh http://127.0.0.1:3000

# ── confidentiality acceptance ON-BOX (no credential leaves the box) ─────────
say "confidentiality probe: R03 refused pay/liability; R07 allowed"
node - <<'EOF'
const fs = require('fs');
const C = require('/opt/hcmos/src/crypto');
const creds = fs.readFileSync('/root/uat-credentials.txt', 'utf8');
function grab(email) {
  // LAST occurrence: earlier deploy runs re-seeded and re-provisioned, so the
  // file can hold stale generations above the current one.
  const i = creds.lastIndexOf(email);
  if (i < 0) throw new Error('no creds for ' + email);
  const chunk = creds.slice(i, i + 600);
  const password = /password :\s*(\S+)/.exec(chunk)[1];
  const secret = /TOTP\s+:\s*([A-Z2-7]+)/.exec(chunk)[1];
  return { email, password, secret };
}
async function login(u) {
  const r = await fetch('http://127.0.0.1:3000/auth/console', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: u.email, password: u.password, mfa: C.currentTotp(u.secret) }),
  });
  if (r.status !== 200) throw new Error(`login ${u.email}: ${r.status}`);
  return (await r.json()).token;
}
(async () => {
  const r03 = await login(grab('uat.probe.r03@taifamining.tz'));
  const r07 = await login(grab('cecilia.mtweve@taifamining.tz'));
  const code = async (tok, path) =>
    (await fetch('http://127.0.0.1:3000' + path, { headers: { authorization: 'Bearer ' + tok } })).status;
  const liab03 = await code(r03, '/reports/register/leave-liability/00000000-0000-0000-0000-000000000000');
  const liab07 = await code(r07, '/reports/register/leave-liability/00000000-0000-0000-0000-000000000000');
  // R03 must be 403 at the gate; R07 passes the gate (404 = gate passed, batch absent).
  const dirRes = await fetch('http://127.0.0.1:3000/employees?limit=1', { headers: { authorization: 'Bearer ' + r03 } });
  const rows = (await dirRes.json()).rows || [];
  let payLeak = false;
  if (rows.length) {
    const emp = await (await fetch('http://127.0.0.1:3000/employees/' + rows[0].id, { headers: { authorization: 'Bearer ' + r03 } })).json();
    payLeak = 'basic_pay' in emp || 'bank_account' in emp;
  }
  const pass = liab03 === 403 && liab07 !== 403 && !payLeak;
  console.log(`R03 liability register: ${liab03} (want 403)`);
  console.log(`R07 liability register: ${liab07} (want not-403; 404 = gate passed)`);
  console.log(`R03 profile pay fields absent: ${!payLeak}`);
  console.log(pass ? 'CONFIDENTIALITY PROBE PASS' : 'CONFIDENTIALITY PROBE FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1); });
EOF

say "remote setup complete"
echo "systemd: $(systemctl is-active hcmos) · postgres loopback: $(ss -tln | grep -c '127.0.0.1:5432') · ref: $DEPLOY_REF"
