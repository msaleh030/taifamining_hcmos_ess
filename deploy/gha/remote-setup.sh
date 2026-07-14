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

# ── the MAIN unit ships with the repo — reinstall it on every deploy so unit
# changes (e.g. the kiosk photo StateDirectory sandbox carve-out, 2026-07-14)
# actually reach the box; provisioning-time installs go stale otherwise.
install -m 644 deploy/hcmos.service /etc/systemd/system/hcmos.service
systemctl daemon-reload
systemctl restart hcmos

# ── the RUNNING process serves THIS deploy — never trust "systemd: active" ────
# `systemctl enable --now` never bounced a running service, so before run 29 the
# box could pass every checkpoint while SERVING WEEKS-OLD CODE (the disk and DB
# were current; the process was not). /health now reports the build the process
# read at startup; a mismatch here is a FAILED deploy, loudly.
say "running process serves THIS deploy (health.build == BUILD_SHA)"
WANT=$(cut -c1-12 "$APP_DIR/BUILD_SHA" 2>/dev/null || echo '')
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && break; sleep 1; done
GOT=$(curl -fsS http://127.0.0.1:3000/health \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).build||"unstamped"))')
echo "serving build: $GOT · deployed: ${WANT:-unknown} · process started: $(systemctl show hcmos -p ExecMainStartTimestamp --value)"
if [ -n "$WANT" ] && [ "$GOT" != "$WANT" ]; then
  echo "FAIL: the RUNNING process does not serve this deploy — the restart did not take effect"
  exit 1
fi

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

prov() { # email name role site [scope-sites 'A;B' for a multi-site set]
  local email="$1" name="$2" role="$3" site="$4" scope="${5:-}"
  if sudo -u postgres psql -d hcmos -Atc "SELECT 1 FROM app_user WHERE company_id='$UAT_CO' AND lower(email)=lower('$email')" | grep -q 1; then
    echo "exists: $email ($role)"; return 0
  fi
  UAT_COMPANY="$UAT_CO" UAT_EMAIL="$email" UAT_NAME="$name" UAT_ROLE="$role" UAT_SITE="$site" \
    UAT_SCOPE_SITES="$scope" \
    node scripts/provision-uat-user.js >> "$CREDS" 2>&1 \
    && echo "provisioned: $email ($role, ${scope:-$site})" || { echo "FAILED: $email ($role)"; return 1; }
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
# 4th R03 CONFIRMED (Kira 2026-07-12): Advera Speratus (the roster's 'Alvera
# Salvator' was WRONG). MULTI-SITE scope: BOTH North Mara projects — two
# DISTINCT sites, per user_site_scope (never merged). Anchor = L&H.
prov advera.speratus@taifamining.tz 'Advera Speratus' R03 "North Mara - L&H and Airstrip Project" \
  'North Mara - L&H and Airstrip Project;North Mara - TSF Lift 10 Project'
# CLEANUP (Kira): if an account was ever created for the WRONG name, remove it —
# no orphan R03 with site scope for a person who does not exist. Expected: none
# (the 4th officer was HELD, never provisioned) — verify and report either way.
WRONG=$(sudo -u postgres psql -d hcmos -Atc \
  "SELECT id FROM app_user WHERE company_id='$UAT_CO' AND lower(email)='alvera.salvator@taifamining.tz'")
if [ -n "$WRONG" ]; then
  sudo -u postgres psql -d hcmos -c "
    DELETE FROM session WHERE user_id='$WRONG';
    DELETE FROM user_site_scope WHERE user_id='$WRONG';
    DELETE FROM app_user WHERE id='$WRONG';" >/dev/null
  echo "CLEANUP: alvera.salvator@ account EXISTED — removed (sessions + scope + account)."
else
  echo "CLEANUP CHECK: no alvera.salvator@ account exists (the 4th officer was HELD, never provisioned) — nothing to remove."
fi
# Confirmed matrix accounts (Kira 2026-07-12): R04 x2 + R06 + R14, all central
# ('All sites' by role, migration 029) — HQ is only the employee-record anchor.
prov baraka.nsemwa@taifamining.tz     'Baraka Nsemwa'     R04 "$HQ_SITE"
prov poonam.divecha@taifamining.tz    'Poonam Divecha'    R04 "$HQ_SITE"
prov maurice.mwendabai@taifamining.tz 'Maurice Mwendabai' R06 "$HQ_SITE"
prov richard.tainton@taifamining.tz   'Richard Tainton'   R14 "$HQ_SITE"
# Matrix name note (reported, NOT changed): the matrix writes 'Alvera Salvator'
# for advera.speratus@ — the account keeps the name Kira corrected earlier
# (Advera Speratus); her scope is BOTH North Mara projects, as provisioned.
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

# ── SCOPE RULINGS (Kira 2026-07-12, second): every R03 carries an EXPLICIT
# user_site_scope SET (a fallback-to-employee-site R03 becomes an explicit
# singleton; Advera's two-site NM set is already rows); the management tier
# (R04/R07/R12/R14/R15/R16 — plus R06/R11 from earlier rulings) is CENTRAL,
# enforced by migration 031 in the site_scope table, verified here.
say "R03 explicit multi-site sets + central-role verification (Kira ruling)"
sudo -u postgres psql -d hcmos -c "
  INSERT INTO user_site_scope(company_id, user_id, site_id)
  SELECT u.company_id, u.id, e.site_id
    FROM app_user u JOIN employee e ON e.id = u.employee_id
   WHERE u.company_id='$UAT_CO' AND u.role_code='R03' AND e.site_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM user_site_scope s WHERE s.user_id = u.id);"
sudo -u postgres psql -d hcmos -c "
  SELECT u.email, array_agg(st.name ORDER BY st.name) AS explicit_site_set
    FROM app_user u
    JOIN user_site_scope s ON s.user_id = u.id
    JOIN site st ON st.id = s.site_id
   WHERE u.company_id='$UAT_CO' AND u.role_code='R03'
   GROUP BY u.email ORDER BY u.email;"
echo "central vs site-bound (site_scope config after migration 031):"
sudo -u postgres psql -d hcmos -c "
  SELECT role_code, CASE WHEN scoped THEN 'SITE-BOUND' ELSE 'CENTRAL (all sites)' END AS scope
    FROM site_scope
   WHERE role_code IN ('R01','R02','R03','R04','R06','R07','R11','R12','R14','R15','R16')
   ORDER BY role_code;"

# ── CANONICAL SIX-SITE MODEL (Kira 2026-07-12) ────────────────────────────────
# North Mara is TWO sites (L&H/Airstrip + TSF Lift 10) with independent HR
# scoping; Nyanzaga carries its project name; Dar Yard is new. Legacy names are
# renamed IN PLACE (site ids — and so every scope/zone reference — survive).
say "canonical six-site model (rename legacy, create missing)"
apt-get install -y -qq unzip >/dev/null 2>&1 || true
UAT_COMPANY=$UAT_CO hcmos-run node scripts/canonical-sites.js

# ── scaffold purge: per-site, Kira-authorized (NM 2026-07-09; all sites 07-12) ─
# Clears SYNTHETIC seed rows so the real masters ARE the directory. Fail-closed
# per scripts/purge-nm-scaffold.js: only position-NULL rows with a non-numeric/
# absent legacy_id and NO app_user link; one transaction; audited; idempotent.
say "scaffold purge (per-site synthetic seed rows — Kira-authorized)"
while IFS= read -r SITE_NAME; do
  PURGE_SITE="$SITE_NAME" UAT_COMPANY=$UAT_CO hcmos-run node scripts/purge-nm-scaffold.js \
    || echo "PURGE REFUSED for '$SITE_NAME' — nothing deleted (fail-closed)"
done <<'SITES'
Head Office
Mwadui
North Mara - L&H and Airstrip Project
North Mara - TSF Lift 10 Project
Nyanzaga - Sotta Mining Project
Dar Yard
SITES

# ── employee masters: SIX sites from the original .xlsx files ─────────────────
# Kira drops the six ORIGINAL xlsx files into /root/uat-data (PII — NEVER the
# repo). Each converts on-box to the canonical template CSV (scripts/
# xlsx-to-master.js: header auto-detect, variant mapping, serial→ISO dates,
# shared-mailbox emails blanked) and loads through the audited maker-checker
# ingest (maker Omar R15 / checker Viswa R16). Canonical per-site control totals
# with allow_shortfall (Kira: known-bad rows carry as flagged EXCEPTIONS, the
# gap is REPORTED; an OVERSHOOT still hard-blocks). Idempotent re-runs enrich.
say "employee masters (six sites; canonical 1,044: 50/374/173/94/282/71)"
load_site() { # xlsx-file site-name canonical-count
  local XLSX="/root/uat-data/$1" SITE="$2" COUNT="$3"
  if [ ! -f "$XLSX" ]; then echo "AWAITING: $1 (drop into /root/uat-data — PII, never the repo)"; return 0; fi
  local CSV="${XLSX%.xlsx}.master.csv" CTL="${XLSX%.xlsx}.control.json"
  hcmos-run node scripts/xlsx-to-master.js "$XLSX" "$CSV" --site "$SITE" || { echo "CONVERT FAILED: $1"; return 0; }
  printf '[{"site":"%s","count":%s,"allow_shortfall":true}]\n' "$SITE" "$COUNT" > "$CTL"
  UAT_COMPANY=$UAT_CO hcmos-run node scripts/load-ingest.js employee-master "$CSV" "$CTL" \
    omar.omar@taifamining.tz viswa.medhuru@taifamining.tz --commit \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s.slice(s.indexOf("{")));console.log(`  loaded=${r.loaded||0} clean=${r.clean} exceptions=${r.exceptions} flagged=${r.warned} control_ok=${r.control_ok}`);for(const[k,n]of Object.entries(r.exception_kinds||{}))console.log(`    EXC ${String(n).padStart(4)}x ${k}`);for(const[k,n]of Object.entries(r.warning_kinds||{}))console.log(`    warn ${String(n).padStart(4)}x ${k}`);}catch(e){console.log(s);}})' \
    || echo "  LOAD FAILED for $SITE — see ${CSV}.exceptions.json on the box"
}
load_site "Employee_Master_File_HO.xlsx"              "Head Office"                            50
load_site "Employee_Master_File_Mwadui.xlsx"          "Mwadui"                                374
load_site "Employee_Master_File_North_Mara.xlsx"      "North Mara - L&H and Airstrip Project" 173
load_site "North_Mara_TSF_Employee_Masterfile.xlsx"   "North Mara - TSF Lift 10 Project"       94
load_site "Employee_Master_File_Nyanzaga.xlsx"        "Nyanzaga - Sotta Mining Project"       282
load_site "Master_File_Dar_Yard.xlsx"                 "Dar Yard"                               71

# ── proposed ESS emails: DRAFT list for Taifa IT/HR (Kira ruling 2026-07-12) ──
# Convention firstname.lastname@taifamining.tz, but the system NEVER invents a
# login: a derived address may not exist as a mailbox, and name collisions map
# two people onto one login. The full list (names — PII) goes to a 600 file ON
# THE BOX; this log carries counts only. Confirmed addresses come back through
# the employee-master enrich load, where a duplicate email is an EXCEPTION.
say "proposed ESS emails (DRAFT for IT/HR confirmation — never auto-assigned)"
UAT_COMPANY=$UAT_CO hcmos-run node scripts/propose-emails.js /root/proposed-emails.csv \
  || echo "propose-emails FAILED (non-fatal)"

# ── the second wave: leave / expat permits / payroll (Kira 2026-07-12) ────────
# Order per Kira: employee masters FIRST (above), then leave (attaches by PF at
# site), then expat permits (keyed on PF, not name), then payroll (behind the
# pay-visibility gate). Controls for these are DERIVED from the converted file
# (no independent totals were supplied): that catches conversion/load drift but
# does NOT verify source truth — stated on every load.
load_file() { # xlsx-file site-name conv-kind loader-kind
  local XLSX="/root/uat-data/$1" SITE="$2" CKIND="$3" LKIND="$4"
  if [ ! -f "$XLSX" ]; then echo "AWAITING: $1 (drop into /root/uat-data — PII, never the repo)"; return 0; fi
  local CSV="${XLSX%.xlsx}.$CKIND.csv" CTL="${XLSX%.xlsx}.$CKIND.control.json"
  hcmos-run node scripts/xlsx-to-master.js "$XLSX" "$CSV" ${SITE:+--site "$SITE"} --kind "$CKIND" \
    || { echo "CONVERT FAILED: $1"; return 0; }
  hcmos-run node scripts/derive-control.js "$LKIND" "$CSV" > "$CTL" || { echo "CONTROL DERIVE FAILED: $1"; return 0; }
  echo "  controls DERIVED from the file (no independent totals) — catches conversion/load drift, NOT source truth"
  UAT_COMPANY=$UAT_CO hcmos-run node scripts/load-ingest.js "$LKIND" "$CSV" "$CTL" \
    omar.omar@taifamining.tz viswa.medhuru@taifamining.tz --commit \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s.slice(s.indexOf("{")));console.log(`  loaded=${r.loaded||0} clean=${r.clean} exceptions=${r.exceptions} flagged=${r.warned} control_ok=${r.control_ok}`);for(const[k,n]of Object.entries(r.exception_kinds||{}))console.log(`    EXC ${String(n).padStart(4)}x ${k}`);for(const[k,n]of Object.entries(r.warning_kinds||{}))console.log(`    warn ${String(n).padStart(4)}x ${k}`);}catch(e){console.log(s);}})' \
    || echo "  LOAD FAILED for ${SITE:-$1} — see ${CSV}.exceptions.json on the box"
}

# ── Geofence zones (Kira Wave 4, 2026-07-13): six CONFIRMED zones incl. Dar
# Yard's corrected NEGATIVE latitude. The seed parse-checks TZ bounds and the
# DB guard (migration 034) fails any sign error loudly at INSERT.
say "geofence zones (six confirmed; TZ-bounds guarded; Dar Yard latitude corrected)"
UAT_COMPANY=$UAT_CO hcmos-run node scripts/seed-geofences.js || echo "GEOFENCE SEED FAILED — see the parse-back above"

say "leave masters (attach by PF at site; balances -> protected opening buckets)"
load_file "Leave_Master_File_Head_Office.xlsx"      "Head Office"                       leave opening-balance
load_file "Leave_Master_File_Mwadui.xlsx"           "Mwadui"                            leave opening-balance
load_file "Leave_Master_File_North_Mara_TSF10.xlsx" "North Mara - TSF Lift 10 Project"  leave opening-balance
load_file "Leave_Master_File_Nyanzaga.xlsx"         "Nyanzaga - Sotta Mining Project"   leave opening-balance
echo "GAP (report to Kira): no leave master for 'North Mara - L&H and Airstrip Project' — only the earlier northmara-leave balances exist there"
echo "GAP (report to Kira): no leave master for 'Dar Yard' — no opening balances loaded for that site"

say "expat permits (Kira A3: match by NAME against the loaded masters; TWO docs/person; fail closed)"
if [ -f /root/uat-data/Expat_Permits_Master_File.xlsx ]; then
  hcmos-run node scripts/expat-permits-convert.js /root/uat-data/Expat_Permits_Master_File.xlsx \
    /root/uat-data/Expat_Permits_Master_File.permits.csv /root/uat-data/Expat_Permits_Master_File.classify.csv \
    || echo "CONVERT FAILED: Expat_Permits_Master_File.xlsx"
  if [ -f /root/uat-data/Expat_Permits_Master_File.permits.csv ]; then
    hcmos-run node scripts/derive-control.js permits /root/uat-data/Expat_Permits_Master_File.permits.csv \
      > /root/uat-data/Expat_Permits_Master_File.permits.control.json
    echo "  controls DERIVED from the file (no independent totals) — catches conversion/load drift, NOT source truth"
    UAT_COMPANY=$UAT_CO hcmos-run node scripts/load-ingest.js permits \
      /root/uat-data/Expat_Permits_Master_File.permits.csv /root/uat-data/Expat_Permits_Master_File.permits.control.json \
      omar.omar@taifamining.tz viswa.medhuru@taifamining.tz --commit \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s.slice(s.indexOf("{")));console.log(`  loaded=${r.loaded||0} clean=${r.clean} exceptions=${r.exceptions} flagged=${r.warned} control_ok=${r.control_ok}`);for(const[k,n]of Object.entries(r.exception_kinds||{}))console.log(`    EXC ${String(n).padStart(4)}x ${k}`);for(const[k,n]of Object.entries(r.warning_kinds||{}))console.log(`    warn ${String(n).padStart(4)}x ${k}`);}catch(e){console.log(s);}})' \
      || echo "  PERMIT LOAD FAILED — see the exceptions report next to the CSV"
    echo "-- expat classification (is_expat + permit_type), same name-matching:"
    UAT_COMPANY=$UAT_CO hcmos-run node scripts/classify-expats.js \
      /root/uat-data/Expat_Permits_Master_File.classify.csv /root/expat-classification-report.txt \
      || echo "classification FAILED (non-fatal; documents themselves are loaded)"
  fi
else
  echo "AWAITING: Expat_Permits_Master_File.xlsx (drop into /root/uat-data — PII, never the repo)"
fi

say "payroll master (North Mara — BOTH projects; behind the pay gate, maker-checker)"
# The June summary covers the whole North Mara complex (run 36: 110 of 285
# rows had no PF at L&H — the TSF people). Convert + load once per project
# site: each row's identity check (PF at site + name) decides which pass it
# belongs to; the other pass reports it as an exception, never a wrong write.
# Geometry probe first (header labels + fill %, never values): locates the
# REAL amount columns in the two-tier summary (run 37: BASIC SALARY header
# mapped but 0% filled — the values live under different labels).
hcmos-run node scripts/xlsx-to-master.js /root/uat-data/Payroll_Master_File_North_Mara.xlsx \
  /tmp/payroll-geometry-probe.csv --site "North Mara - L&H and Airstrip Project" --kind payroll --geometry \
  2>/dev/null | tail -1 || true
rm -f /tmp/payroll-geometry-probe.csv
load_file "Payroll_Master_File_North_Mara.xlsx" "North Mara - L&H and Airstrip Project" payroll payroll-master
if [ -f /root/uat-data/Payroll_Master_File_North_Mara.xlsx ]; then
  cp -f /root/uat-data/Payroll_Master_File_North_Mara.xlsx /root/uat-data/Payroll_NM_TSF_pass.xlsx
  load_file "Payroll_NM_TSF_pass.xlsx" "North Mara - TSF Lift 10 Project" payroll payroll-master
fi

# ── User_Accounts_Matrix: READ AND REPORT ONLY (Kira 2026-07-12) ─────────────
# "READ IT FIRST AND REPORT BEFORE PROVISIONING ANYTHING." This step provisions
# NOTHING: it reports accounts/roles/sites/surfaces and flags every row that
# would violate the auth split (console = email+password+MFA, ESS = device+PIN;
# both surfaces = TWO credentials). Per-row detail (PII) → 600 on-box file.
say "user accounts matrix — audit + scope mapping, read + report ONLY (no provisioning)"
UAM=$(ls /root/uat-data/Taifa_User_Accounts.xlsx /root/uat-data/User_Accounts_Matrix.xlsx 2>/dev/null | head -1 || true)
if [ -n "$UAM" ]; then
  echo "matrix file: $UAM (newest of Taifa_User_Accounts / User_Accounts_Matrix)"
  UAT_COMPANY=$UAT_CO hcmos-run node scripts/report-user-matrix.js \
    "$UAM" /root/user-accounts-matrix-report.txt \
    || echo "matrix report FAILED (non-fatal — nothing was provisioned)"
else
  echo "AWAITING: Taifa_User_Accounts.xlsx (drop into /root/uat-data — PII, never the repo)"
fi

# ── legacy North Mara leave CSV (pre-master path) — kept for compatibility ────
NM_LEAVE=$(ls /root/uat-data/northmara-leave.csv /root/uat-data/northmara-opening-balance*.csv 2>/dev/null | head -1 || true)
if [ -n "$NM_LEAVE" ] && [ -f "/root/uat-data/northmara-leave.control.json" ]; then
  say "re-attach leave (legacy northmara-leave.csv, matched by PF)"
  UAT_COMPANY=$UAT_CO hcmos-run node scripts/load-ingest.js opening-balance \
    "$NM_LEAVE" /root/uat-data/northmara-leave.control.json \
    omar.omar@taifamining.tz viswa.medhuru@taifamining.tz --commit \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s.slice(s.indexOf("{")));console.log(`leave attach: rows=${r.rows} clean(attached)=${r.clean} no-match(exceptions)=${r.exceptions} committed=${r.committed} loaded=${r.loaded||0}`);}catch(e){console.log(s);}})' \
    || echo "LEAVE LOAD FAILED — see the exception report next to the CSV"
fi

# ── ESS devices (Kira A1): every matrix person gets a SEPARATE device + PIN —
# console password and ESS PIN are two credentials on two surfaces, never one.
# Super Admin row skipped (Kira's interactive step); unresolvable rows flagged.
say "ESS device + PIN registration (matrix people; PINs -> credentials file, 600)"
UAM2=$(ls /root/uat-data/Taifa_User_Accounts.xlsx /root/uat-data/User_Accounts_Matrix.xlsx 2>/dev/null | head -1 || true)
if [ -n "$UAM2" ]; then
  UAT_COMPANY=$UAT_CO hcmos-run node scripts/provision-ess-devices.js "$UAM2" "$CREDS" \
    || echo "ESS device provisioning FAILED (non-fatal)"
else
  echo "AWAITING: user accounts matrix"
fi

# ── stale submitted batches (B3): run 35's aborted approves left 'submitted'
# staging rows. They can never commit silently (approve is an explicit checker
# action) but they clutter the history — mark them aborted after an hour.
say "stale submitted ingest batches -> aborted (housekeeping)"
sudo -u postgres psql -d hcmos -c "
  UPDATE ingest_batch SET status='aborted'
   WHERE company_id='$UAT_CO' AND status='submitted'
     AND created_at < now() - interval '1 hour'" | head -1

# ── bare cross-site orphans: identity-less rows whose PF is MASTERED at a
# different site (run 34's leave load created 16 such at TSF before the
# validator was tightened). REPORT ONLY — deleting or re-siting a person is a
# Kira/Head-of-HR ruling, never automatic. Their balances stay attached; the
# source files retain the data either way.
say "bare cross-site orphans (report only — Kira ruling needed)"
sudo -u postgres psql -d hcmos -c "
  SELECT s.name AS site,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM employee m WHERE m.company_id=e.company_id
                    AND m.legacy_id=e.legacy_id AND m.site_id<>e.site_id AND m.position IS NOT NULL)) AS twin_mastered_elsewhere,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM employee m WHERE m.company_id=e.company_id
                    AND m.legacy_id=e.legacy_id AND m.site_id<>e.site_id AND m.position IS NOT NULL)) AS twin_bare_only
    FROM employee e JOIN site s ON s.id = e.site_id
   WHERE e.company_id='$UAT_CO' AND e.position IS NULL
     AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.employee_id = e.id)
     AND EXISTS (SELECT 1 FROM employee m WHERE m.company_id = e.company_id
                   AND m.legacy_id = e.legacy_id AND m.site_id <> e.site_id)
   GROUP BY s.name ORDER BY s.name"
# Full exception LIST for Kira/Baraka to work through during UAT (names/PFs —
# PII, so a 600 on-box file; this log carries only the counts above).
sudo -u postgres psql -d hcmos -Atc "
  SELECT e.legacy_id || ',' || s.name || ',' || e.full_name || ',' ||
         coalesce((SELECT string_agg(s2.name || ':' || CASE WHEN m.position IS NULL THEN 'bare' ELSE 'mastered' END, ' | ')
            FROM employee m JOIN site s2 ON s2.id = m.site_id
           WHERE m.company_id = e.company_id AND m.legacy_id = e.legacy_id AND m.id <> e.id), '')
    FROM employee e JOIN site s ON s.id = e.site_id
   WHERE e.company_id='$UAT_CO' AND e.position IS NULL
     AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.employee_id = e.id)
     AND EXISTS (SELECT 1 FROM employee m WHERE m.company_id = e.company_id
                   AND m.legacy_id = e.legacy_id AND m.site_id <> e.site_id)
   ORDER BY s.name, e.legacy_id" > /root/orphan-exceptions.csv
sed -i '1i pf,site,full_name,twins' /root/orphan-exceptions.csv
chmod 600 /root/orphan-exceptions.csv
echo "orphan exception list (names/PFs): /root/orphan-exceptions.csv (600, on-box only)"

# ── ingest provenance: every batch ever committed on this box (counts only) ──
# Answers "where did these balances come from" definitively — e.g. opening
# buckets exist for sites our pipeline never loaded (Kira's on-box loads).
say "ingest batch history (provenance, counts only)"
sudo -u postgres psql -d hcmos -c "
  SELECT kind, status, clean_count, exception_count,
         to_char(created_at, 'MM-DD HH24:MI') AS created,
         to_char(committed_at, 'MM-DD HH24:MI') AS committed
    FROM ingest_batch WHERE company_id='$UAT_CO'
   ORDER BY created_at" | tail -40

# ── field completeness: what the loads ACTUALLY populated, straight from the DB
# Counts only (no PII in this log). This is the honest tally the Omid probe's
# "master-loaded" is checked against — if these are populated and the API shows
# zero, the SERVING code is stale, not the data.
say "field completeness after all loads (per-site DB counts, no PII)"
sudo -u postgres psql -d hcmos -c "
  SELECT s.name                 AS site,
         count(e.id)            AS employees,
         count(e.position)      AS with_position,
         count(e.email)         AS with_email,
         count(e.joined_at)     AS with_join_date,
         count(e.manager_id)    AS with_manager,
         count(p.employee_id)   AS with_pay_row,
         count(p.national_id)   AS with_national_id,
         count(p.basic_salary)  AS with_basic_salary
    FROM employee e
    JOIN site s ON s.id = e.site_id
    LEFT JOIN employee_pay p ON p.employee_id = e.id
   WHERE e.company_id='$UAT_CO'
   GROUP BY s.name ORDER BY s.name"
sudo -u postgres psql -d hcmos -c "
  SELECT s.name AS site, count(DISTINCT lc.employee_id) AS employees_with_opening_balance,
         round(sum(lc.days)::numeric, 2) AS opening_days_total
    FROM leave_carry lc
    JOIN employee e ON e.id = lc.employee_id
    JOIN site s ON s.id = e.site_id
   WHERE lc.company_id='$UAT_CO' AND lc.opening_bucket
   GROUP BY s.name ORDER BY s.name"

# ── VERIFY IT'S ALIVE: log in AS OMID and count what HE sees via the real API ─
# This is the honest verification: not a DB count, but Omid's actual session
# paging the actual /employees endpoint (R11 = Head of HR, central, all sites).
# It also reports his login state on every run (Kira: confirm he can
# authenticate BEFORE we rely on "Omid sees the directory").
say "Omid's directory (login as omid.karambeck@ + page /employees, per canonical site)"
SITE_MAP=$(sudo -u postgres psql -d hcmos -Atc \
  "SELECT json_agg(json_build_object('name', name, 'id', id) ORDER BY name)
     FROM site WHERE company_id='$UAT_CO'")
SITE_MAP=$SITE_MAP node - <<'EOF'
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
  // Per-site directory counts across the CANONICAL six-site model — what the
  // central R11 actually sees through the real API, per site.
  const sites = JSON.parse(process.env.SITE_MAP); // [{name,id}]
  let grandTotal = 0, grandMaster = 0;
  for (const s of sites) {
    let cursor = null, total = 0, withPosition = 0;
    do {
      const url = `http://127.0.0.1:3000/employees?limit=200&site=${s.id}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const page = await (await fetch(url, { headers: { authorization: 'Bearer ' + token }, signal: T() })).json();
      for (const r of page.rows) { total++; if (r.position) withPosition++; }
      cursor = page.next_cursor;
    } while (cursor);
    grandTotal += total; grandMaster += withPosition;
    console.log(`OMID SEES: ${s.name.padEnd(40)} total ${String(total).padStart(5)} · master-loaded ${String(withPosition).padStart(4)}`);
  }
  console.log(`OMID SEES TOTAL: ${grandTotal} directory rows · ${grandMaster} master-loaded (canonical 1,044)`);
})().catch((e) => { console.error('OMID PROBE ERROR:', e.message); process.exit(1); });
EOF

# ── expat classification (is_expat + permit_type) — gated on the CSV drop ────
say "expat classification (legacy 61-name list -> is_expat + permit_type)"
if [ -f /root/uat-data/Expat_Permits_Master_File.permits.csv ]; then
  echo "SUPERSEDED: the PF-keyed Expat_Permits_Master_File classification ran above (Kira: key on PF, not name)."
elif [ -f /root/uat-data/expat-permit-classification.csv ]; then
  # Counts print here; NAMES/PII go only to the 600-mode report on the box —
  # this log is public with the repo, so the report never echoes through it.
  UAT_COMPANY=$UAT_CO node "$APP_DIR/scripts/classify-expats.js" \
    /root/uat-data/expat-permit-classification.csv /root/expat-classification-report.txt \
    && echo "report (names, on-box only): /root/expat-classification-report.txt"
else
  echo "AWAITING: Expat_Permits_Master_File.xlsx (PF-keyed, preferred) or expat-permit-classification.csv in /root/uat-data (NEVER the repo — passports/PII)."
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

# ── Wave 6: daily document/permit expiry alert sweep (DA-2 routing) ───────────
# Net-new units this wave — INSTALL them (the backup timer above was already on
# the box from provisioning; these are not). Enabling the timer schedules the
# 03:07 UTC sweep; we also fire ONE sweep now so the alerts dashboard reflects
# this deploy. The sweep is idempotent per day (no double-notify on replay).
say "expiry-alert sweep (daily timer + one immediate run)"
install -m 644 deploy/hcmos-expiry-alerts.service /etc/systemd/system/hcmos-expiry-alerts.service
install -m 644 deploy/hcmos-expiry-alerts.timer   /etc/systemd/system/hcmos-expiry-alerts.timer
systemctl daemon-reload
systemctl enable --now hcmos-expiry-alerts.timer 2>/dev/null || echo "expiry-alerts timer not enabled"
hcmos-run node scripts/run-expiry-alerts.js 2>&1 | tail -6 || echo "initial expiry sweep skipped (will run at 03:07 UTC)"
echo "expiry-alerts timer: $(systemctl is-enabled hcmos-expiry-alerts.timer 2>/dev/null || echo unknown) · next: $(systemctl show hcmos-expiry-alerts.timer -p NextElapseUSecRealtime --value 2>/dev/null)"

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
  // NEWEST console block wins (earlier deploys re-provisioned, so the file
  // holds stale generations above the current one) — but the email ALSO
  // appears in ESS-device blocks now, which carry a PIN, not a password.
  // Walk back until a chunk with console fields; never read past the next
  // block marker (a 600-char window could bleed into a NEIGHBOUR's password).
  for (let i = creds.lastIndexOf(email); i >= 0; i = creds.lastIndexOf(email, i - 1)) {
    const next = creds.slice(i + 1).search(/=== UAT user provisioned ===|--- ESS DEVICE/);
    const chunk = creds.slice(i, next < 0 ? i + 600 : Math.min(i + 600, i + 1 + next));
    const password = /password :\s*(\S+)/.exec(chunk);
    const secret = /TOTP\s+:\s*([A-Z2-7]+)/.exec(chunk);
    if (password && secret) return { email, password: password[1], secret: secret[1] };
  }
  throw new Error('no console creds for ' + email);
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

# ── post-restart security re-verification (Kira 2026-07-12) ──────────────────
# Everything "verified live" before the stale-serving fix may have been checked
# against old code. These probes hit the RUNNING process over HTTP and FAIL the
# deploy on any regression: rank lattice (R03 -> R12 reset refused), leave
# cycle-scoping (prior-cycle taken never double-charges), MFA toggle (field
# visibility AND enforcement from the one key).
say "post-restart security re-verification (rank lattice / leave cycle / MFA toggle — live process)"
MFA_SETUP_PHASE=${MFA_SETUP_PHASE:-1} UAT_COMPANY=$UAT_CO hcmos-run node scripts/probe-security.js

# ── expat field-change gate (Kira 2026-07-14): MAKER = R03 (site HR), CHECKER =
# R11 (Head of HR); the CEO (R14) is read-only everywhere. Live probe of the
# fail-closed direction (needs no site-matched maker and leaves ZERO residue):
# every role that must NOT raise an expat change is refused —
#   • R04 (central HR Manager) → 403, message names site HR (R03);
#   • R11 (Head of HR) → 403 — R11 is now the CHECKER, no longer the maker;
#   • R14 (CEO) → 403 — read-only everywhere.
# The positive R03-raises / R11-decides path is pinned by test/expat_gate.test.js.
# FAILS the deploy.
say "expat field-change gate probe: R04/R11/R14 all refused as maker (live process)"
EXPAT_ID=$(sudo -u postgres psql -d hcmos -Atc \
  "SELECT id FROM employee WHERE company_id='$UAT_CO' AND is_expat=true LIMIT 1")
if [ -z "$EXPAT_ID" ]; then
  echo "SKIP: no is_expat employee on the box (classification matched none) — gate stays pinned by the local suite"
else
  EXPAT_ID="$EXPAT_ID" node - <<'EOF'
const fs = require('fs');
const creds = fs.readFileSync('/root/uat-credentials.txt', 'utf8');
const re = /email\s*:\s*(\S+)[\s\S]*?password\s*:\s*(\S+)/g;
const latest = new Map(); let m;
while ((m = re.exec(creds))) latest.set(m[1], m[2]);
const T = () => AbortSignal.timeout(10000);
async function login(email) {
  const r = await fetch('http://127.0.0.1:3000/auth/console', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: T(),
    body: JSON.stringify({ email, password: latest.get(email) }) }); // MFA off (setup)
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`);
  return (await r.json()).token;
}
const change = (tok, body) => fetch(`http://127.0.0.1:3000/employees/${process.env.EXPAT_ID}/change`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
  signal: T(), body: JSON.stringify(body) });
(async () => {
  const r04 = await login('baraka.nsemwa@taifamining.tz');   // central HR Manager — NOT an expat maker
  const r11 = await login('omid.karambeck@taifamining.tz');  // Head of HR — now the CHECKER, not the maker
  const r14 = await login('richard.tainton@taifamining.tz'); // CEO/Executive — read-only everywhere
  const body = { field: 'phone', value: '0700000000' };
  const r04res = await change(r04, body); const r04b = await r04res.json();
  const r11res = await change(r11, body);                     // R11 is no longer a maker → 403
  const r14res = await change(r14, body);                     // R14 read-only → 403
  // All three MUST be refused; R04's refusal names the new maker (site HR / R03).
  const pass = r04res.status === 403 && /site HR|R03/.test(r04b.error || '')
    && r11res.status === 403 && r14res.status === 403;
  console.log(`R04 change on expat: ${r04res.status} (want 403) — "${r04b.error || ''}"`);
  console.log(`R11 change on expat: ${r11res.status} (want 403 — R11 is the CHECKER, not the maker)`);
  console.log(`R14 change on expat: ${r14res.status} (want 403 — CEO read-only everywhere)`);
  console.log(pass ? 'EXPAT FIELD-CHANGE GATE PROBE PASS' : 'EXPAT FIELD-CHANGE GATE PROBE FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1); });
EOF
fi

# ── stale-serving window: when did the hcmos process (re)start historically? ──
# `enable --now` never bounced a running service before run 29's fix, so the
# journal's start/stop history IS the record of what code was actually serving
# and since when. Timestamps only — nothing sensitive.
say "hcmos process start/stop history (stale-serving window evidence)"
journalctl -u hcmos --no-pager -o short-iso 2>/dev/null \
  | grep -E 'Started|Stopping|Stopped|Deactivated' | tail -20 \
  || echo "journal history unavailable (rotated?)"

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
