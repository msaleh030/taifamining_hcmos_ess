#!/usr/bin/env bash
# Hostinger API driver for the HCMOS UAT deploy — run from YOUR machine (the
# Claude Code sandbox's network policy blocks developers.hostinger.com, so this
# runs operator-side). Token via env only:
#
#   export HOSTINGER_API_TOKEN=...     # hPanel → API → generate (ROTATED token)
#   bash deploy/hostinger-api.sh preflight
#
# Phases (each idempotent, prints the raw API response):
#   preflight   read-only: data centers, OS templates, your VMs, your SSH keys.
#               Find the AMSTERDAM (nl) datacenter id + the Ubuntu 24.04 template id.
#   addkey      register an SSH public key:      addkey "uat-key" ~/.ssh/id_ed25519.pub
#   postinstall register deploy/hostinger-post-install.sh as a post-install script
#   firewall    create the UAT firewall (deny-in except SSH from YOUR_IP) and
#               attach it to a VM:               firewall <vm_id> <your_ip>
#   status      show a VM:                       status <vm_id>
#
# ORDERING the VPS (the only money-moving step) is done in hPanel — KVM 2,
# Frankfurt (DE), Ubuntu 24.04, attach the SSH key + post-install script registered
# above. Approved spend: KVM 2 (~$7–10/mo). Doing it in the panel avoids guessing
# the billing API's order schema; everything after it is API/scripted.
#
# NOTE: the VPS API is beta; if a path 404s, check developers.hostinger.com — the
# phases are separated so one wrong path never affects the others.
set -euo pipefail
: "${HOSTINGER_API_TOKEN:?export HOSTINGER_API_TOKEN first (hPanel → API; never commit it)}"
BASE="https://developers.hostinger.com/api"
hapi() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE$path" \
      -H "Authorization: Bearer $HOSTINGER_API_TOKEN" -H "Content-Type: application/json" \
      -d "$body"
  else
    curl -sS -X "$method" "$BASE$path" -H "Authorization: Bearer $HOSTINGER_API_TOKEN"
  fi
  echo
}

cmd="${1:-preflight}"; shift || true
case "$cmd" in
  preflight)
    echo "== data centers (pick the Frankfurt / de id — 19 as of 2026-07) =="
    hapi GET /vps/v1/data-centers
    echo "== OS templates (pick Ubuntu 24.04) =="
    hapi GET /vps/v1/templates
    echo "== your virtual machines =="
    hapi GET /vps/v1/virtual-machines
    echo "== your SSH keys =="
    hapi GET /vps/v1/public-keys
    ;;
  addkey)
    name="${1:?addkey <name> <path-to-.pub>}"; pub="${2:?addkey <name> <path-to-.pub>}"
    hapi POST /vps/v1/public-keys "$(printf '{"name":"%s","key":"%s"}' "$name" "$(cat "$pub")")"
    ;;
  postinstall)
    script_b64_free=$(sed 's/"/\\"/g' deploy/hostinger-post-install.sh | sed ':a;N;$!ba;s/\n/\\n/g')
    hapi POST /vps/v1/post-install-scripts \
      "$(printf '{"name":"hcmos-uat-post-install","content":"%s"}' "$script_b64_free")"
    ;;
  firewall)
    vm="${1:?firewall <vm_id> <your_ip>}"; ip="${2:?firewall <vm_id> <your_ip>}"
    echo "== create firewall =="
    hapi POST /vps/v1/firewall '{"name":"hcmos-uat"}'
    echo "!! Take the firewall id from above, then add the SSH rule + activate:"
    echo "   bash $0 fwrule <firewall_id> $ip   &&   bash $0 fwactivate <firewall_id> $vm"
    ;;
  fwrule)
    fw="${1:?fwrule <firewall_id> <your_ip>}"; ip="${2:?fwrule <firewall_id> <your_ip>}"
    hapi POST "/vps/v1/firewall/$fw/rules" \
      "$(printf '{"protocol":"TCP","port":"22","source":"custom","source_detail":"%s","action":"accept"}' "$ip")"
    ;;
  fwactivate)
    fw="${1:?fwactivate <firewall_id> <vm_id>}"; vm="${2:?fwactivate <firewall_id> <vm_id>}"
    hapi POST "/vps/v1/firewall/$fw/activate/$vm" '{}'
    ;;
  status)
    vm="${1:?status <vm_id>}"
    hapi GET "/vps/v1/virtual-machines/$vm"
    ;;
  *) echo "unknown phase: $cmd (preflight|addkey|postinstall|firewall|fwrule|fwactivate|status)"; exit 2 ;;
esac
