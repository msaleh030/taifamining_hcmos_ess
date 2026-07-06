#!/usr/bin/env bash
# Post-deploy smoke test. Run ON THE BOX against the local app:
#   bash deploy/smoke-test.sh http://127.0.0.1:3000
# (Run locally because the Cloudflare Access gate intercepts unauthenticated
# requests at the edge — which is itself the I-1 check: opening
# https://uat.taifamining.tz in a browser MUST show the Access login first.)
set -uo pipefail
BASE="${1:-http://127.0.0.1:3000}"
pass=0; fail=0
chk() { local desc="$1"; shift; if "$@" >/dev/null 2>&1; then echo "PASS  $desc"; pass=$((pass+1)); else echo "FAIL  $desc"; fail=$((fail+1)); fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

chk "health returns ok+db"            bash -c "curl -fsS $BASE/health | grep -q '\"db\":true'"
# The designed (enforced) build carries the UAT strip as text in the shell; the
# legacy scaffold used id=uat-banner — accept either so both roots pass.
chk "frontend served (designed root)"  bash -c "curl -fsS $BASE/ | grep -qiE 'uat-banner|HCMOS'"
chk "legacy scaffold retired to /legacy" bash -c "curl -fsS $BASE/legacy/ | grep -q 'uat-banner'"
chk "API requires auth (401)"         bash -c "[ \"\$(code $BASE/me/landing)\" = 401 ]"
chk "directory requires auth (401)"   bash -c "[ \"\$(code $BASE/employees)\" = 401 ]"
chk "ingest requires auth (401)"      bash -c "[ \"\$(code -X POST $BASE/ingest/opening-balance/preview)\" = 401 ]"
chk "Postgres loopback-only"          bash -c "! ss -tln | grep ':5432' | grep -vE '127\.0\.0\.1|\[::1\]' | grep -q ."

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
