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
DEPLOY_REF=$(cat "$APP_DIR/BUILD_SHA" 2>/dev/null || (cd "$APP_DIR" && git rev-parse --short HEAD 2>/dev/null) || echo 'tarball')
echo "deployed ref: $DEPLOY_REF (tarball of the CI-enforced head; dist included: $(test -f $APP_DIR/frontend/dist/index.html && echo yes || echo NO))"

# ── base stack + hardened DB + app service (LOCAL_SRC: no clone) ─────────────
say "post-install (Node LTS, Postgres 16, UFW, scram, systemd)"
cd "$APP_DIR"
LOCAL_SRC=1 bash deploy/hostinger-post-install.sh

# hcmos-run: run any on-box command with the SAME environment the systemd
# service gets (EnvironmentFile sourced) — a bare shell otherwise misses
# PG_OWNER_PW and owner-role scripts fail scram auth.
cat > /usr/local/bin/hcmos-run <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
set -a; . /etc/hcmos/hcmos.env; set +a
cd /opt/hcmos
exec "$@"
EOF
chmod 755 /usr/local/bin/hcmos-run

set -a; . /etc/hcmos/hcmos.env; set +a

# ── CONSOLE MFA setup-phase toggle (REVERSIBLE — one flag, field + enforcement)
# MFA_SETUP_PHASE=1 (setup): auth.mfa.required=0 for EVERY tenant → the console
#   login HIDES the MFA field (GET /auth/config) AND the server does NOT enforce
#   it. Both flip together because both read this one key.
# MFA_SETUP_PHASE=0 (UAT WEEK): auth.mfa.required=1 → field VISIBLE + enforced.
# ‼️  UAT WEEK REVERSAL: set MFA_SETUP_PHASE=0 in .github/workflows/deploy-uat.yml
#     and refire (or on the box: hcmos-run ... UPDATE config SET value='1' ...).
#     A half-flip is impossible — one key drives both. Set for ALL tenants so the
#     pre-auth field-visibility read can never disagree with per-tenant enforcement.
say "console MFA toggle (setup-phase=${MFA_SETUP_PHASE:-1})"
MFA_VALUE=$([ "${MFA_SETUP_PHASE:-1}" = "0" ] && echo 1 || echo 0)
sudo -u postgres psql -d hcmos -c \
  "UPDATE config SET value='$MFA_VALUE' WHERE key='auth.mfa.required'" >/dev/null
echo "auth.mfa.required set to $MFA_VALUE for all tenants ($([ "$MFA_VALUE" = 0 ] && echo 'setup: field HIDDEN + not enforced' || echo 'UAT: field VISIBLE + enforced'))"

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
# Acceptance-probe R03 (temporary, clearly named; kept for the confidentiality
# probe alongside the now-confirmed named officers):
prov uat.probe.r03@taifamining.tz   'UAT Probe (HR Officer)' R03 "$ANY_SITE"
# R03 HR Officers — SITE-SCOPED (Baraka/Omid confirmed, 2026-07-09). prov()
# resolves the site by name; if a site is not on the box yet (loaded from the
# data), it logs FAILED for that one — re-run after the data load.
prov yusuph.kabeza@taifamining.tz   'Yusuph Kabeza'    R03 "Mwadui"
prov ali.mbarouk@taifamining.tz     'Ali Mbarouk'      R03 "$HQ_SITE"       # Head Office
prov ramadhan.mchomvu@taifamining.tz 'Ramadhan Mchomvu' R03 "Nyanzaga"
# 4th R03 (North Mara) is HELD: name discrepancy — Baraka 'Advera Speratus' vs
# roster 'Alvera Salvator' (alvera.salvator@). NOT provisioned until Kira
# confirms name+email (a wrong name = wrong email = broken login).
echo "HELD (name discrepancy, Kira to confirm): 4th R03 North Mara — 'Advera Speratus' vs 'Alvera Salvator'"
echo "PENDING NAMES (provision when Taifa HR confirms): 2x R04, maurice.<surname> R06, richard.<surname> R14"
# hcmos-run sources the service's EnvironmentFile first — a bare `node`
# invocation misses PG_OWNER_PW and fails Postgres auth.
if ! grep -q 'hcmos-run node scripts/provision-super-admin.js' "$CREDS" 2>/dev/null; then
  { echo "SUPER ADMINS (interactive, hidden password — Kira runs on this box):"
    echo "  UAT_COMPANY=$UAT_CO hcmos-run node scripts/provision-super-admin.js mohammed@railgrid.tz"
    echo "  UAT_COMPANY=$UAT_CO hcmos-run node scripts/provision-super-admin.js admin@taifamining.tz"
  } >> "$CREDS"
fi
echo "SUPER ADMINS (interactive, hidden password — Kira runs on this box):"
echo "  UAT_COMPANY=$UAT_CO hcmos-run node scripts/provision-super-admin.js mohammed@railgrid.tz"
echo "  UAT_COMPANY=$UAT_CO hcmos-run node scripts/provision-super-admin.js admin@taifamining.tz"

# ── scaffold purge: North-Mara-ONLY, Kira-authorized 2026-07-09 ───────────────
# Clears the SYNTHETIC seed rows so the real master IS the directory. Strictly
# scoped + fail-closed (see scripts/purge-nm-scaffold.js): only North Mara rows
# with position NULL, a non-numeric/absent legacy_id (seed 'E00001' style — every
# real load carries a numeric PF), and NO app_user link. One transaction, row-set
# re-verified before any delete, audited on the hash-chain. Idempotent: a re-run
# finds 0 candidates.
say "scaffold purge (North-Mara-only synthetic seed rows — Kira-authorized)"
UAT_COMPANY=$UAT_CO hcmos-run node scripts/purge-nm-scaffold.js \
  || { echo "PURGE REFUSED — nothing deleted (fail-closed); see the reason above"; }

# ── employee master: POPULATE the North Mara directory (285 real employees) ───
# Identity-only load through the SAME audited maker-checker ingest (maker = Omar
# R15, checker = Viswa R16). The CSV carries national_id/tin/bank (PII) so it
# lives ONLY under /root/uat-data — NEVER the repo; this public log prints counts
# only. Directory-visible: name/position/department/site. Confidential
# (pay-gated): national_id/tin/bank. Idempotent: a re-run finds the PFs already
# loaded (exceptions) and changes nothing.
say "employee master load (North Mara directory: 285 real employees)"
NM_MASTER=/root/uat-data/northmara-employee-master.csv
if [ -f "$NM_MASTER" ]; then
  # Independent control total (from Baraka's source document, NOT derived from
  # the file): 285 North Mara headcount. A mismatch hard-blocks the commit.
  echo '[{"site":"North Mara","count":285}]' > /root/uat-data/northmara-employee-master.control.json
  UAT_COMPANY=$UAT_CO hcmos-run node scripts/load-ingest.js employee-master \
    "$NM_MASTER" /root/uat-data/northmara-employee-master.control.json \
    omar.omar@taifamining.tz viswa.medhuru@taifamining.tz --commit \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s.slice(s.indexOf("{")));console.log(`master load: header_row=${r.mapping.header_row} rows=${r.rows} clean=${r.clean} flagged(punch-list)=${r.warned} exceptions=${r.exceptions} control_ok=${r.control_ok} committed=${r.committed} loaded=${r.loaded||0}`);}catch(e){console.log(s);}})' \
    || echo "MASTER LOAD FAILED — see the exception report next to the CSV (northmara-employee-master.csv.exceptions.json)"
else
  echo "AWAITING CSV: drop northmara-employee-master.csv into /root/uat-data (NEVER the repo — it carries national_id/tin/bank PII)."
  echo "Then re-run this deploy. Directory-visible: name/position/department/site; confidential (pay-gated): national_id/tin/bank."
fi

# ── re-attach leave: opening balances now MATCH the master by PF ───────────────
# Once the master is loaded, an opening-balance load ATTACHES each balance to the
# real employee record (matched by PF) instead of failing "no employee match".
say "re-attach leave (opening balances -> real North Mara employees, matched by PF)"
NM_LEAVE=$(ls /root/uat-data/northmara-leave.csv /root/uat-data/northmara-opening-balance*.csv 2>/dev/null | head -1 || true)
if [ -n "$NM_LEAVE" ] && [ -f "/root/uat-data/northmara-leave.control.json" ]; then
  UAT_COMPANY=$UAT_CO hcmos-run node scripts/load-ingest.js opening-balance \
    "$NM_LEAVE" /root/uat-data/northmara-leave.control.json \
    omar.omar@taifamining.tz viswa.medhuru@taifamining.tz --commit \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s.slice(s.indexOf("{")));console.log(`leave attach: rows=${r.rows} clean(attached)=${r.clean} no-match(exceptions)=${r.exceptions} committed=${r.committed} loaded=${r.loaded||0}`);}catch(e){console.log(s);}})' \
    || echo "LEAVE LOAD FAILED — see the exception report next to the CSV"
else
  echo "AWAITING CSV: drop northmara-leave.csv + northmara-leave.control.json into /root/uat-data."
  echo "Balances whose PF is in the master ATTACH to that employee; unmatched PFs report as 'no employee match'."
fi

# ── VERIFY IT'S ALIVE: log in AS OMID and count what HE sees via the real API ─
# This is the honest verification: not a DB count, but Omid's actual session
# paging the actual /employees endpoint (R11 = Head of HR, central, all sites).
# It also reports his login state on every run (Kira: confirm he can
# authenticate BEFORE we rely on "Omid sees the directory").
say "Omid's directory (login as omid.karambeck@ + page /employees for North Mara)"
NM_SITE_ID=$(sudo -u postgres psql -d hcmos -Atc \
  "SELECT id FROM site WHERE company_id='$UAT_CO' AND name='North Mara' LIMIT 1")
NM_SITE_ID=$NM_SITE_ID node - <<'EOF'
const fs = require('fs');
const creds = fs.readFileSync('/root/uat-credentials.txt', 'utf8');
// Newest password per email (the matrix accumulates across deploys).
const re = /email\s*:\s*(\S+)[\s\S]*?password\s*:\s*(\S+)/g;
const latest = new Map(); let m;
while ((m = re.exec(creds))) latest.set(m[1], m[2]);
const password = latest.get('omid.karambeck@taifamining.tz');
const T = () => AbortSignal.timeout(10000);
(async () => {
  if (!password) { console.log('OMID LOGIN: NO CREDENTIALS in the matrix — provision step missing?'); process.exit(1); }
  const login = await fetch('http://127.0.0.1:3000/auth/console', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: T(),
    body: JSON.stringify({ email: 'omid.karambeck@taifamining.tz', password }), // MFA off (setup phase)
  });
  if (login.status !== 200) {
    console.log(`OMID LOGIN: FAILED (${login.status}) — fix before relying on directory verification`);
    process.exit(1);
  }
  console.log('OMID LOGIN: OK (email+password, MFA off in setup phase)');
  const token = (await login.json()).token;
  let cursor = null, total = 0, withPosition = 0;
  do {
    const url = `http://127.0.0.1:3000/employees?limit=200&site=${process.env.NM_SITE_ID}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const page = await (await fetch(url, { headers: { authorization: 'Bearer ' + token }, signal: T() })).json();
    for (const r of page.rows) { total++; if (r.position) withPosition++; }
    cursor = page.next_cursor;
  } while (cursor);
  console.log(`OMID SEES: ${total} North Mara directory rows (${withPosition} with position = master-loaded)`);
})().catch((e) => { console.error('OMID PROBE ERROR:', e.message); process.exit(1); });
EOF

# ── expat classification (is_expat + permit_type) — gated on the CSV drop ────
say "expat classification (61-name authoritative list -> is_expat + permit_type)"
if [ -f /root/uat-data/expat-permit-classification.csv ]; then
  # Counts print here; NAMES/PII go only to the 600-mode report on the box —
  # this log is public with the repo, so the report never echoes through it.
  UAT_COMPANY=$UAT_CO node "$APP_DIR/scripts/classify-expats.js" \
    /root/uat-data/expat-permit-classification.csv /root/expat-classification-report.txt \
    && echo "report (names, on-box only): /root/expat-classification-report.txt"
else
  echo "AWAITING CSV: drop expat-permit-classification.csv into /root/uat-data (NEVER the repo — it carries passports/PII)."
  echo "Then re-run this deploy, or on the box: UAT_COMPANY=$UAT_CO hcmos-run node scripts/classify-expats.js /root/uat-data/expat-permit-classification.csv /root/expat-classification-report.txt"
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
// Every request is bounded (10s) so a wedged app fails the probe fast rather
// than hanging the whole deploy on an unresponsive port.
const T = () => AbortSignal.timeout(10000);
async function login(u) {
  const r = await fetch('http://127.0.0.1:3000/auth/console', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: T(),
    body: JSON.stringify({ email: u.email, password: u.password, mfa: C.currentTotp(u.secret) }),
  });
  if (r.status !== 200) throw new Error(`login ${u.email}: ${r.status}`);
  return (await r.json()).token;
}
(async () => {
  const r03 = await login(grab('uat.probe.r03@taifamining.tz'));
  const r07 = await login(grab('cecilia.mtweve@taifamining.tz'));
  const code = async (tok, path) =>
    (await fetch('http://127.0.0.1:3000' + path, { headers: { authorization: 'Bearer ' + tok }, signal: T() })).status;
  const liab03 = await code(r03, '/reports/register/leave-liability/00000000-0000-0000-0000-000000000000');
  const liab07 = await code(r07, '/reports/register/leave-liability/00000000-0000-0000-0000-000000000000');
  // R03 must be 403 at the gate; R07 passes the gate (404 = gate passed, batch absent).
  const dirRes = await fetch('http://127.0.0.1:3000/employees?limit=1', { headers: { authorization: 'Bearer ' + r03 }, signal: T() });
  const rows = (await dirRes.json()).rows || [];
  let payLeak = false;
  if (rows.length) {
    const emp = await (await fetch('http://127.0.0.1:3000/employees/' + rows[0].id, { headers: { authorization: 'Bearer ' + r03 }, signal: T() })).json();
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

# ── activation summary: every provisioned account logs in on EMAIL+PASSWORD ──
# During setup MFA is off, so console login is email+password only. Parse the
# 600-mode matrix, attempt each account, report X of N. Counts only — no
# credential is printed to this (public) CI log.
say "activation summary (email+password, MFA off in setup)"
node - <<'EOF'
const fs = require('fs');
const creds = fs.readFileSync('/root/uat-credentials.txt', 'utf8');
// The matrix ACCUMULATES across deploys (re-seeds appended new generations),
// so an email can appear more than once. Keep the NEWEST password per email
// (last write wins) — the current credential — exactly like the confidentiality
// probe's lastIndexOf. Trying an older generation would 401 on a valid account.
const re = /email\s*:\s*(\S+)[\s\S]*?password\s*:\s*(\S+)/g;
const latest = new Map(); let m;
while ((m = re.exec(creds))) latest.set(m[1], m[2]); // later match overwrites
const accounts = [...latest].map(([email, password]) => ({ email, password }));
const T = () => AbortSignal.timeout(10000);
(async () => {
  let ok = 0; const fails = [];
  for (const a of accounts) {
    try {
      const r = await fetch('http://127.0.0.1:3000/auth/console', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: T(),
        body: JSON.stringify({ email: a.email, password: a.password }), // NO mfa (setup)
      });
      if (r.status === 200) ok++; else fails.push(`${a.email}:${r.status}`);
    } catch (e) { fails.push(`${a.email}:ERR`); }
  }
  console.log(`ACTIVATION: ${ok} of ${accounts.length} provisioned accounts authenticate on email+password`);
  if (fails.length) console.log(`  did not authenticate: ${fails.join(', ')}`);
  console.log('NOTE: super admins (Kira, interactive) + pending-name roster are NOT in this file yet — target roster is 15.');
})().catch((e) => { console.error('ACTIVATION ERROR:', e.message); });
EOF

say "remote setup complete"
echo "systemd: $(systemctl is-active hcmos) · postgres loopback: $(ss -tln | grep -c '127.0.0.1:5432') · ref: $DEPLOY_REF"
