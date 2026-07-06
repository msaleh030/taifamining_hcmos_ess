#!/usr/bin/env bash
# Production-region latency shootout — Kira's directive: Hostinger production
# region = lowest measured RTT to Tanzania, chosen EMPIRICALLY. Contenders from
# the account catalogue: FRANKFURT (DC 19, current UAT) vs MUMBAI (DC 23).
#
# Runs ON THE GITHUB ACTIONS RUNNER (open egress). Uses the free Globalping
# probe network (globalping.io) to ping targets FROM East Africa — Tanzania
# first, neighbours for corroboration. Targets pair a neutral cloud endpoint
# per contender region (Vultr + Linode publish permanent ping hosts), plus the
# REAL Hostinger Frankfurt box (the UAT VM) as the on-network datum — its edge
# may filter ICMP, in which case its rows read "no reply" and the neutral pairs
# carry the comparison. No secrets, no cost, nothing provisioned.
set -euo pipefail
API=https://api.globalping.io/v1
say() { printf '\n=== %s ===\n' "$*"; }

# label|target — Frankfurt contenders then Mumbai contenders.
TARGETS=(
  "FRA hostinger-uat|152.239.121.249"
  "FRA vultr|fra-de-ping.vultr.com"
  "FRA linode|speedtest.frankfurt.linode.com"
  "BOM vultr|bom-in-ping.vultr.com"
  "BOM linode|speedtest.mumbai1.linode.com"
)
COUNTRIES=(TZ KE UG RW MZ ET)

say "probe availability in East Africa"
PROBES="$(curl -sS "$API/probes")"
for c in "${COUNTRIES[@]}"; do
  n="$(echo "$PROBES" | jq --arg c "$c" '[.[] | select(.location.country == $c)] | length')"
  cities="$(echo "$PROBES" | jq -r --arg c "$c" '[.[] | select(.location.country == $c) | .location.city] | unique | join(", ")')"
  echo "$c: $n probe(s) ${cities:+($cities)}"
done

say "create measurements (ping, 8 packets, up to 3 probes per country)"
WORK=$(mktemp -d)
REQS="$WORK/requests.tsv"   # id \t country \t label
: > "$REQS"
for c in "${COUNTRIES[@]}"; do
  avail="$(echo "$PROBES" | jq --arg c "$c" '[.[] | select(.location.country == $c)] | length')"
  [ "$avail" -gt 0 ] || { echo "skip $c (no probes)"; continue; }
  for t in "${TARGETS[@]}"; do
    label="${t%%|*}"; target="${t##*|}"
    body=$(jq -nc --arg tgt "$target" --arg c "$c" \
      '{type:"ping", target:$tgt, locations:[{country:$c}], limit:3, measurementOptions:{packets:8}}')
    resp="$(curl -sS -X POST "$API/measurements" -H 'content-type: application/json' -d "$body")"
    id="$(echo "$resp" | jq -r '.id // empty')"
    if [ -n "$id" ]; then
      printf '%s\t%s\t%s\n' "$id" "$c" "$label" >> "$REQS"
    else
      echo "WARN: create failed for $c -> $label: $(echo "$resp" | jq -c '.' 2>/dev/null || echo "$resp")"
    fi
    sleep 1   # stay well inside the unauthenticated rate limit
  done
done
[ -s "$REQS" ] || { echo "FATAL: no measurements created (probe availability or rate limit — see above)"; exit 1; }

say "collect results"
mkdir -p probe-results
printf '%-8s %-4s %-22s %-34s %8s %8s %8s %6s\n' REGION CC LABEL PROBE MIN AVG MAX LOSS%
while IFS=$'\t' read -r id c label; do
  for i in $(seq 1 30); do
    out="$(curl -sS "$API/measurements/$id")"
    [ "$(echo "$out" | jq -r '.status')" = "finished" ] && break
    sleep 2
  done
  echo "$out" > "probe-results/$c-${label// /_}-$id.json"
  echo "$out" | jq -r --arg c "$c" --arg label "$label" '
    (.results // [])[] |
    [ ($label | split(" ")[0]), $c, $label,
      ((.probe.city // "?") + " / " + (.probe.network // "?" | .[0:24])),
      (.result.stats.min // "-"), (.result.stats.avg // "-"),
      (.result.stats.max // "-"), (.result.stats.loss // "-") ] | @tsv' \
  | while IFS=$'\t' read -r reg cc lab probe mn av mx ls; do
      printf '%-8s %-4s %-22s %-34s %8s %8s %8s %6s\n' "$reg" "$cc" "$lab" "$probe" "$mn" "$av" "$mx" "$ls"
    done
done < "$REQS"

say "summary — median of per-probe avg RTT (ms), by country and region"
jq -s '
  [ .[] | (.results // [])[] as $r
    | select($r.result.stats.avg != null)
    | { c: $r.probe.country,
        reg: (if (.target | test("fra|frankfurt|152.239")) then "FRANKFURT" else "MUMBAI" end),
        avg: $r.result.stats.avg } ]
  | group_by(.c + .reg)
  | map({ country: .[0].c, region: .[0].reg,
          n: length,
          median: (sort_by(.avg) | .[(length/2|floor)].avg) })
  | sort_by(.country, .region)' probe-results/*.json
echo
echo "Reading: lower median wins for that country. TZ rows are decisive; the"
echo "neighbours corroborate the cable geography. Kira picks the winner."
