# HCMOS UAT — GO checklist (confirmed decisions)

**Approved by Kira:** Hostinger **KVM 2** (2 vCPU / 8 GB, ~$7–10/mo), **Netherlands
(Amsterdam)**, Ubuntu 24.04 LTS. UAT / test data under the residency waiver
(`deploy/UAT-RESIDENCY-WAIVER.md`); production must be af-south-1.

Steps 1–3, 6 run on the box (or via the Hostinger API/MCP with a **rotated** token
as an env var — never in chat). Steps 4–5 are in **your Cloudflare account**.

## 1. Order the VPS  (→ I-2)
- KVM 2, **Amsterdam (NL)**, **Ubuntu 24.04** (verify it's in the OS-template list;
  if only 22.04 is offered, that's fine — the post-install installs Postgres 16 from
  PGDG regardless).
- Register an **SSH public key** and attach it; **key-only auth, no password SSH**.

## 2. Firewall  (→ I-3)
- Attach a firewall: **deny all inbound except SSH (22) from known RailGrid IPs**.
- Using the Cloudflare Tunnel (step 5) → open **no** inbound 443 (the tunnel dials
  out). Public-IP path instead → also allow 443.

## 3. Build the box  (→ I-3, I-4)
- Paste `deploy/hostinger-post-install.sh` into the VPS **post-install script** field
  (or run as root). It: installs Node LTS + Postgres 16, sets UFW, clones the repo at
  the green ref, **generates real DB secrets** into `/etc/hcmos/hcmos.env` (600),
  runs the hardened DB setup (scram, localhost, no trust) + migrate + seed
  scaffolding, and starts the app under systemd on `127.0.0.1:3000`.
- Confirm: `ss -tlnp | grep 5432` shows loopback only; `systemctl status hcmos` active.

## 4. UAT users + MFA  (→ I-5)
On the box:
```
set -a; . /etc/hcmos/hcmos.env; set +a; cd /opt/hcmos
UAT_COMPANY=11111111-1111-1111-1111-111111111111 UAT_EMAIL=admin@taifamining.tz \
UAT_NAME='Mohammed Saleh' UAT_ROLE=R11 UAT_SITE='Head Office' node scripts/provision-uat-user.js
```
R11 (HR Director) is central — sees every site's directory + permit alerts (I-5).
Enrol the printed `otpauth://` in your authenticator; rotate the printed password.

Provision the TWO finance users for the data load (v1.5 LI-6: the ingest
maker-checker is a role-split SoD — Finance Manager submits, CFC approves):
```
UAT_COMPANY=11111111-1111-1111-1111-111111111111 UAT_EMAIL=finmgr@taifamining.tz \
UAT_NAME='<Finance Manager>' UAT_ROLE=R15 UAT_SITE='Head Office' node scripts/provision-uat-user.js
UAT_COMPANY=11111111-1111-1111-1111-111111111111 UAT_EMAIL=cfc@taifamining.tz \
UAT_NAME='<Chief Financial Controller>' UAT_ROLE=R16 UAT_SITE='Head Office' node scripts/provision-uat-user.js
```

LI-7 — the SUPER ADMIN (R12, unscoped, MFA mandatory). INTERACTIVE: the password
is typed hidden at the console and stored hash-only — never in repo/config/env,
never printed. Enrol the printed otpauth in your authenticator (shown once):
```
UAT_COMPANY=11111111-1111-1111-1111-111111111111 node scripts/provision-super-admin.js mohammed@railgrid.tz
```

## 5. Cloudflare — DNS + TLS + Access + cache  (→ I-1)  [your account]
Follow `deploy/cloudflare-edge.md`:
- Tunnel `hcmos-uat` → `http://localhost:3000`; `cloudflared tunnel route dns
  hcmos-uat uat.taifamining.tz` (proxied CNAME).
- Access app on `uat.taifamining.tz`, allow `@taifamining.tz` + `mohammed@railgrid.tz`.
- Cache: bypass the API, cache static assets only.

## 6. Backups  (→ I-6)
- Enable Hostinger VPS snapshots via the panel/API.
- Set `BACKUP_TARGET` (in-region object storage) in `/etc/hcmos/hcmos.env`, then
  `systemctl enable --now hcmos-backup.timer`. **Run one restore test** (commands at
  the foot of `deploy/backup.sh`) and record it.

## 7. Real data  (→ I-5 full)
Drop the **340 opening balances + permit files** (CSV) on the box, prepare a
`control.json` with the EXPECTED totals **from the source document** (independent
check), then load through the ingestion discipline via the loader:
```
cd /opt/hcmos; set -a; . /etc/hcmos/hcmos.env; set +a
# dry-run first — prints clean/exception split + control check, loads NOTHING:
node scripts/load-ingest.js opening-balance balances.csv control.json \
     finmgr@taifamining.tz cfc@taifamining.tz
# review balances.csv.exceptions.json, then commit (maker finmgr@ R15, checker cfc@ R16):
node scripts/load-ingest.js opening-balance balances.csv control.json \
     finmgr@taifamining.tz cfc@taifamining.tz --commit
# permits mirror (control.json = {"count": N}):
node scripts/load-ingest.js permits permits.csv permits-control.json \
     finmgr@taifamining.tz cfc@taifamining.tz --commit
```
Balances land in the protected **opening bucket** (lapse-exempt). Verify with
`bash deploy/smoke-test.sh`, then log in as the R11 account and confirm the
directory shows the loaded employees. **Stays TEST data** — carry policy +
duplicate-file open with Baraka (`deploy/RATIFY-AT-UAT.md`).

## Acceptance (I-1..I-6)
| ID | Met by |
|----|--------|
| I-1 | Step 5 (reachable, TLS, Access-gated) |
| I-2 | Step 1 (NL recorded; production-residency caveat in the waiver) |
| I-3 | Steps 2–3 (firewall; scram + localhost Postgres) |
| I-4 | Step 3 (generated secrets; NODE_ENV=production; token not in repo) |
| I-5 | Steps 4 + 7 (HR account sees real employees + permit alerts) |
| I-6 | Step 6 (nightly off-box backup + tested restore) |

Deploy from a **CI-green** commit (the branch is green — the workflow is the gate).
