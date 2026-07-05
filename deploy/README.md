# HCMOS/ESS — UAT deployment runbook

Stand up a **UAT** instance (test data, reloadable, clearly labelled) reachable at a
subdomain of `taifamining.tz`, gated to named testers. This directory holds the
**hardened, provider-agnostic tooling**; the steps below are executed by an operator
with the accounts/secrets (this repo's CI environment cannot reach Hostinger,
Cloudflare, DNS, or the secret store, and does not contain the real test-data files).

> ⚠️ **Data residency — waiver on record.** The DPA/registry commit the origin +
> Postgres to **af-south-1**, but Hostinger has no South-Africa region. Kira has
> accepted **Hostinger-EU for UAT (test data only)** under a documented waiver —
> see `deploy/UAT-RESIDENCY-WAIVER.md`. The registry value stays `af-south-1`;
> **production must be in-region.** All other hardening below still applies in full.

## Concrete values for this deploy

- Subdomain: `uat.taifamining.tz` (or `hcmos-uat.taifamining.tz`).
- UAT tenant `company_id`: **`11111111-1111-1111-1111-111111111111`** (the seeded test tenant).
- Loaded sites (names for `UAT_SITE`): `Head Office`, `Nyanzaga`, `North Mara`, `Mwadui`.
- Origin: Hostinger-EU box; Postgres local; Cloudflare Tunnel → `localhost:3000`.

Example — provision the Head of HR (central R11, sees every site):
```
UAT_COMPANY=11111111-1111-1111-1111-111111111111 UAT_EMAIL=kira@taifamining.tz \
UAT_NAME='Kira <surname>' UAT_ROLE=R11 UAT_SITE='Head Office' \
  node scripts/provision-uat-user.js
```

## Host

Single small box (~2 vCPU / 4 GB), **in-region**, running the Node server + Postgres
locally (~$30/mo). Split Postgres to managed later. Create a `hcmos` service user;
deploy the repo to `/opt/hcmos`.

## 1. Secrets (never in git)

```
sudo install -d -m 700 /etc/hcmos
cp deploy/.env.example /etc/hcmos/hcmos.env   # fill REAL secrets, rotate off seed values
sudo chmod 600 /etc/hcmos/hcmos.env
```
Set strong, distinct `PG_OWNER_PW` / `PG_APP_PW`, `PGSSLMODE=require` (or `verify-full`
+ CA), `NODE_ENV=production` (this disables the test-only fault seams), and the
in-region `BACKUP_TARGET`.

## 2. Database — hardened, scram-sha-256, localhost-only  (→ D-3)

```
set -a; . /etc/hcmos/hcmos.env; set +a
bash deploy/setup-db.prod.sh          # scram-sha-256, NO trust, listen_addresses=localhost
node scripts/migrate.js               # schema
node scripts/seed.js                  # tenant/config/site SCAFFOLDING (test tenant)
```
`setup-db.prod.sh` refuses to run if any `trust` line exists in `pg_hba.conf`. Postgres
binds to loopback only — never publicly reachable. Confirm: `ss -tlnp | grep 5432`
shows `127.0.0.1`/`::1` only.

## 3. Load the TEST data  (→ D-4)

Load the **340 clean opening balances + parseable permits** through the ingestion
slice (preview → submit → approve; maker-checker, control-totals, atomic). Until the
operator wires the file→endpoint step, the existing load script is acceptable for UAT
(reloadable). **This stays TEST data** — do not treat as a production commit; the
carry policy and duplicate-file questions are open with Baraka. (Opening balances land
in the protected opening bucket, exempt from the lapse — see the ingestion slice.)

## 4. UAT users + MFA  (→ D-4)

Do **not** reuse the seed's shared MFA secret. Provision real accounts, each with its
own password + TOTP enrolment:
```
UAT_COMPANY=<tenant-uuid> UAT_EMAIL=kira@taifamining.tz UAT_NAME='Kira …' \
UAT_ROLE=R11 UAT_SITE='Head Office' node scripts/provision-uat-user.js
```
Give **the Head of HR an R11** account — R11 is *central* (non-site-scoped), so the
directory shows employees at **every** loaded site (Head Office, Nyanzaga, …). For
site-scoped testers (R03/R04) provision one per site — a site-bound role sees only its
own site. The script prints the `otpauth://` URI for the tester to enrol; deliver the
password over a secure channel and rotate.

## 5. Run the server  (process manager, restart-on-failure)

```
sudo cp deploy/hcmos.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hcmos
```
Server listens on `127.0.0.1:3000`, behind the proxy/tunnel — not public.

## 6. Edge: Cloudflare Tunnel + Access + TLS  (→ D-1)

Prefer a **Cloudflare Tunnel** (no inbound ports open on the box):
```
cloudflared tunnel create hcmos-uat
cloudflared tunnel route dns hcmos-uat uat.taifamining.tz
# ingress: uat.taifamining.tz -> http://localhost:3000 ; run: sudo systemctl enable --now cloudflared
```
(If instead using a public IP + nginx/Caddy: DNS **A → origin IP, proxied (orange
cloud)**, only **443** open, origin cert from Cloudflare.)

- **Cloudflare Access (zero-trust)** in front of `uat.taifamining.tz`, policy = allow
  named **Taifa + RailGrid** emails only. UAT is **not** world-reachable.
- **Cache:** a rule to **bypass cache** for the API (respect `no-store` on authenticated
  responses); only static assets (`/*.js`, `/*.css`, `/index.html`) may cache.

## 7. Backups  (→ D-5)

```
sudo cp deploy/hcmos-backup.{service,timer} /etc/systemd/system/
sudo systemctl enable --now hcmos-backup.timer
```
Nightly `pg_dump` (custom format) → **in-region** object storage, 14-night retention.
**Run the restore test once** (commands at the foot of `deploy/backup.sh`) and record
that it succeeded.

## Acceptance map

| ID  | Check | Where |
|-----|-------|-------|
| D-1 | `https://uat.taifamining.tz` reachable, TLS valid, gated by Cloudflare Access | §6 |
| D-2 | Origin + Postgres provider/region confirmed **compliant/in-region** | Host + ⚠️ above |
| D-3 | No `trust` auth anywhere; Postgres not publicly reachable; secrets not in repo | §1, §2 |
| D-4 | A Taifa HR UAT account logs in and sees the real employees + permit alerts | §3, §4 |
| D-5 | Nightly in-region backup runs and a restore is tested once | §7 |

## Deploy discipline

CI (`.github/workflows/ci.yml`, the full 127-test suite) is the gate — **deploy only
from a known-green commit**. Migrations + seed (scaffolding) run before the data load.
