#!/usr/bin/env bash
# UAT deploy orchestrator — runs ON THE GITHUB ACTIONS RUNNER (open egress).
# Provisions/locates the Kira-approved Amsterdam KVM 2 via the Hostinger API,
# asserts the region BEFORE any setup, ships the source tarball (with the
# CI-built ENFORCED frontend dist) over SSH, and drives remote-setup.sh.
# Secrets come from the environment (GitHub Actions secrets, masked in logs):
#   HOSTINGER_API_TOKEN   one-time provisioning credential (rotate after)
#   UAT_SSH_PRIVATE_KEY   deploy keypair private half
#   CLOUDFLARE_TUNNEL_TOKEN (optional) token-managed tunnel for uat.taifamining.tz
# NOTHING here echoes a secret; API responses are filtered through jq to
# non-secret fields before printing.
set -euo pipefail

API=https://developers.hostinger.com/api
HOSTNAME_WANT="${UAT_HOSTNAME:-hcmos-uat}"
say() { printf '\n=== CHECKPOINT: %s ===\n' "$*"; }
hapi() { # method path [json-body]
  local m="$1" p="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$m" "$API$p" -H "Authorization: Bearer $HOSTINGER_API_TOKEN" \
      -H 'content-type: application/json' -d "$body"
  else
    curl -sS -X "$m" "$API$p" -H "Authorization: Bearer $HOSTINGER_API_TOKEN"
  fi
}

: "${HOSTINGER_API_TOKEN:?HOSTINGER_API_TOKEN secret missing}"
: "${UAT_SSH_PRIVATE_KEY:?UAT_SSH_PRIVATE_KEY secret missing}"

# ── SSH key material (private half never printed; public half is safe) ──────
say "ssh deploy key"
install -d -m 700 ~/.ssh
printf '%s\n' "$UAT_SSH_PRIVATE_KEY" > ~/.ssh/uat_deploy
chmod 600 ~/.ssh/uat_deploy
PUBKEY="$(ssh-keygen -y -f ~/.ssh/uat_deploy)"
echo "deploy public key: $PUBKEY"

# ── 1. Locate or provision the VM ────────────────────────────────────────────
say "1. locate/provision the Amsterdam KVM 2"
VMS_JSON="$(hapi GET /vps/v1/virtual-machines)"
echo "$VMS_JSON" | jq -r 'try (.[] | [.id, .hostname, .plan, .state] | @tsv) catch "no VMs / unexpected shape"'

VM_ID="$(echo "$VMS_JSON" | jq -r --arg h "$HOSTNAME_WANT" \
  'try (map(select((.hostname // "" | contains($h)) or ((.plan // "") | test("KVM ?2"; "i")))) | .[0].id // empty) catch empty')"

if [ -z "$VM_ID" ]; then
  echo "No existing VM matched — attempting API order (KVM 2, Amsterdam, Ubuntu 24.04)."
  CATALOG="$(hapi GET /billing/v1/catalog)"
  ITEM_ID="$(echo "$CATALOG" | jq -r 'try ([.[] | select(.name | test("KVM ?2"; "i"))][0].prices[0].id // empty) catch empty')"
  PM_ID="$(hapi GET /billing/v1/payment-methods | jq -r 'try ((map(select(.is_default == true)) | .[0].id) // .[0].id // empty) catch empty')"
  if [ -z "$ITEM_ID" ] || [ -z "$PM_ID" ]; then
    echo "FATAL: cannot self-order (catalog item or payment method not resolvable via API)."
    echo "Order the KVM 2 (Amsterdam, Ubuntu 24.04) in the Hostinger panel, then re-run this deploy."
    exit 1
  fi
  ORDER_OUT="$(hapi POST /billing/v1/orders "{\"payment_method_id\": $PM_ID, \"items\": [{\"item_id\": \"$ITEM_ID\", \"quantity\": 1}]}")"
  echo "$ORDER_OUT" | jq 'del(..|.token?, .secret?)' || true
  echo "Waiting for the new VM to appear..."
  for i in $(seq 1 30); do
    sleep 10
    VM_ID="$(hapi GET /vps/v1/virtual-machines | jq -r 'try (map(select(.state == "initial" or .state == "creating")) | .[0].id // empty) catch empty')"
    [ -n "$VM_ID" ] && break
  done
  [ -n "$VM_ID" ] || { echo "FATAL: ordered but no VM appeared"; exit 1; }
fi
echo "VM id: $VM_ID"

# ── 2. REGION ASSERT: must be Amsterdam before anything else ─────────────────
say "2. region assert (Amsterdam/NL — fixed after setup)"
VM_JSON="$(hapi GET "/vps/v1/virtual-machines/$VM_ID")"
DC_ID="$(echo "$VM_JSON" | jq -r '.data_center_id // .data_center.id // empty')"
DCS="$(hapi GET /vps/v1/data-centers)"
DC_ROW="$(echo "$DCS" | jq -r --argjson id "${DC_ID:-0}" 'try (map(select(.id == $id)) | .[0]) catch empty')"
echo "data centre: $(echo "$DC_ROW" | jq -c '{id, name, city, location, continent} | with_entries(select(.value != null))' 2>/dev/null || echo "$DC_ROW")"
if ! echo "$DC_ROW" | grep -qiE 'amsterdam|netherlands|"nl"'; then
  # A VM in state "initial" has no fixed DC yet — the setup call pins it. Find NL DC.
  STATE="$(echo "$VM_JSON" | jq -r '.state // empty')"
  NL_DC="$(echo "$DCS" | jq -r 'try ([.[] | select((.city // "" | test("Amsterdam"; "i")) or (.location // "" | test("nl|Netherlands|Amsterdam"; "i")))][0].id // empty) catch empty')"
  if [ "$STATE" = "initial" ] && [ -n "$NL_DC" ]; then
    echo "VM awaiting setup — will pin data centre $NL_DC (Amsterdam) at setup."
    DC_ID="$NL_DC"
  else
    echo "FATAL: VM is NOT in Amsterdam and its region is already fixed. Stopping (region is a Kira constraint)."
    exit 1
  fi
fi

# ── 3. Setup (fresh VM only): Ubuntu 24.04 + deploy key ──────────────────────
STATE="$(echo "$VM_JSON" | jq -r '.state // empty')"
if [ "$STATE" = "initial" ]; then
  say "3. initial setup: Ubuntu 24.04 template + deploy key + hostname"
  TPL_ID="$(hapi GET /vps/v1/templates | jq -r 'try ([.[] | select(.name | test("Ubuntu 24.04"; "i"))][0].id // empty) catch empty')"
  [ -n "$TPL_ID" ] || { echo "FATAL: Ubuntu 24.04 template not found"; exit 1; }
  hapi POST "/vps/v1/virtual-machines/$VM_ID/setup" \
    "{\"template_id\": $TPL_ID, \"data_center_id\": $DC_ID, \"hostname\": \"$HOSTNAME_WANT\", \"public_key\": {\"name\": \"hcmos-uat-deploy\", \"key\": \"$PUBKEY\"}}" \
    | jq 'del(..|.token?, .secret?)' || true
else
  say "3. VM already set up (state: $STATE) — deploy key must be authorised on the box"
fi

# ── wait running + IP ─────────────────────────────────────────────────────────
say "wait for running state + IPv4"
IP=""
for i in $(seq 1 60); do
  VM_JSON="$(hapi GET "/vps/v1/virtual-machines/$VM_ID")"
  STATE="$(echo "$VM_JSON" | jq -r '.state // empty')"
  IP="$(echo "$VM_JSON" | jq -r 'try (.ipv4[0].address // .ipv4.address // .ip // empty) catch empty')"
  [ "$STATE" = "running" ] && [ -n "$IP" ] && break
  sleep 10
done
[ -n "$IP" ] || { echo "FATAL: VM never reached running/IP"; exit 1; }
echo "VM running at $IP"

# ── 4. Firewall via API (deny-all inbound; SSH only; tunnel dials out) ───────
say "4. firewall: SSH only, everything else denied (Cloudflare tunnel = zero inbound 443)"
FW_ID="$(hapi GET /vps/v1/firewall | jq -r 'try ([.[] | select(.name == "hcmos-uat-fw")][0].id // empty) catch empty')"
if [ -z "$FW_ID" ]; then
  FW_ID="$(hapi POST /vps/v1/firewall '{"name": "hcmos-uat-fw"}' | jq -r '.id // empty')"
  [ -n "$FW_ID" ] && hapi POST "/vps/v1/firewall/$FW_ID/rules" \
    '{"protocol": "TCP", "port": "22", "source": "any", "source_detail": "any", "action": "accept"}' >/dev/null || true
fi
if [ -n "$FW_ID" ]; then
  hapi POST "/vps/v1/firewall/$FW_ID/activate/$VM_ID" >/dev/null \
    && echo "firewall hcmos-uat-fw active on VM (tighten SSH source to RailGrid IPs in the panel)" \
    || echo "WARN: firewall activation call failed — UFW on the box still enforces the same policy"
else
  echo "WARN: API firewall unavailable — UFW on the box still enforces deny-all+SSH"
fi

# ── 5. Ship source (with enforced dist) + run remote setup ───────────────────
say "5. ship enforced build + run remote setup"
SSH_OPTS=(-i ~/.ssh/uat_deploy -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
for i in $(seq 1 30); do ssh "${SSH_OPTS[@]}" "root@$IP" true 2>/dev/null && break; sleep 10; done
ssh "${SSH_OPTS[@]}" "root@$IP" true || {
  echo "FATAL: SSH as root failed. If the VM predates this deploy, authorise the deploy key:"
  echo "  $PUBKEY"
  exit 1
}

STAGE="$(mktemp -d)"
git archive --format=tar --prefix=hcmos/ HEAD | tar -x -C "$STAGE"
mkdir -p "$STAGE/hcmos/frontend"
cp -r frontend/dist "$STAGE/hcmos/frontend/dist"      # the ENFORCED build from this runner
tar -czf /tmp/hcmos-src.tgz -C "$STAGE" hcmos
scp "${SSH_OPTS[@]}" /tmp/hcmos-src.tgz "root@$IP:/root/hcmos-src.tgz"

# Cloudflare tunnel token (optional) travels via stdin to a 600 file — never argv.
if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  printf 'TUNNEL_TOKEN=%s\n' "$CLOUDFLARE_TUNNEL_TOKEN" \
    | ssh "${SSH_OPTS[@]}" "root@$IP" 'install -d -m 700 /etc/cloudflared && cat > /etc/cloudflared/env && chmod 600 /etc/cloudflared/env'
  echo "tunnel token staged on box (600)"
else
  echo "no CLOUDFLARE_TUNNEL_TOKEN — edge (tunnel/DNS/Access) stays a Kira-side step (deploy/cloudflare-edge.md)"
fi

ssh "${SSH_OPTS[@]}" "root@$IP" 'bash -s' < deploy/gha/remote-setup.sh
say "deploy script finished — see remote checkpoints above"
echo "box: $IP · credentials file for Kira: /root/uat-credentials.txt (600, on-box only)"
