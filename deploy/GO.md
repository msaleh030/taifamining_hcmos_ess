# HCMOS UAT — GO checklist (confirmed decisions)

**Approved by Kira:** Hostinger **KVM 2** (2 vCPU / 8 GB, ~$7–10/mo), **Frankfurt (DE)**, Ubuntu 24.04 LTS. UAT / test data under the residency waiver
(`deploy/UAT-RESIDENCY-WAIVER.md`); production must be af-south-1.

Steps 1–3, 6 run on the box (or via the Hostinger API/MCP with a **rotated** token
as an env var — never in chat). Steps 4–5 are in **your Cloudflare account**.

## 1. Order the VPS  (→ I-2)
- KVM 2, **Frankfurt (DE)**, **Ubuntu 24.04** (verify it's in the OS-template list;
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

## 4. UAT users + MFA  (→ I-5) — the REAL 11-person roster (v1.6)
Emails are `firstname.lastname@taifamining.tz`. On the box, for each row:
```
set -a; . /etc/hcmos/hcmos.env; set +a; cd /opt/hcmos
UAT_COMPANY=11111111-1111-1111-1111-111111111111 UAT_EMAIL=<email> \
UAT_NAME='<Full Name>' UAT_ROLE=<Rxx> UAT_SITE='<site>' node scripts/provision-uat-user.js
```
Enrol each printed `otpauth://` in the holder's authenticator; rotate the
printed password on first sign-in.

| # | Person | Role(s) | Account email(s) |
|---|---|---|---|
| 1 | Yusuph Kabeza | R03 (site-scoped → **Mwadui**) | `yusuph.kabeza@taifamining.tz` |
| 2 | Ali Mbarouk | R03 (site-scoped → **Head Office**) | `ali.mbarouk@taifamining.tz` |
| 3 | Ramadhan Mchomvu | R03 (site-scoped → **Nyanzaga**) | `ramadhan.mchomvu@taifamining.tz` |
| 4 | **HELD — name discrepancy** (North Mara): Baraka 'Advera Speratus' vs roster 'Alvera Salvator'. Kira to confirm name+email before provisioning | R03 (site-scoped → North Mara) | `alvera.salvator@…?` **do not provision yet** |
| 5-6 | HR Managers ×2 (names from Taifa HR) | R04 | `<first.last>@taifamining.tz` |
| 7 | Omid Karambeck | **R11 Head of HR** | `omid.karambeck@taifamining.tz` |
| 8 | Maurice `<surname>` | **R06 SHEQ Manager** (absorbs HSE Officer — no R05 account, v1.6) | `maurice.<surname>@taifamining.tz` |
| 9 | Cecilia Mtweve | **R07 Payroll Officer** | `cecilia.mtweve@taifamining.tz` |
| 10 | Omar Omar | **R15 Finance Manager** (ingest MAKER) | `omar.omar@taifamining.tz` |
| 11 | Viswa Medhuru | **R16 Chief Financial Controller** (ingest CHECKER) | `viswa.medhuru@taifamining.tz` |
| 12 | Rajesh Chohan | R12 System Administrator (UNSCOPED — role config, All Sites) | `rajesh.chohan@taifamining.tz` |
| 13 | Richard `<surname>` | R14 CEO / Executive (read-only, org-wide) | `richard.<surname>@taifamining.tz` |

R11 (Head of HR) is central — sees every site's directory + permit alerts (I-5).

**SoD is preserved (LI-6):** the ingest maker is **Omar Omar (R15)** and the
checker is **Viswa Medhuru (R16)** — two dedicated people, no dual-role
+alias accounts (Kira's revision). Do NOT vest maker+checker in one person;
the same-user-403 rule never self-blocks with this roster.

> **‼️ SETUP-PHASE MFA (reversible):** during setup the console MFA field is
> HIDDEN and enforcement is OFF, via the single flag `auth.mfa.required=0`
> (`MFA_SETUP_PHASE='1'` in the deploy). **UAT week: flip it back** — set
> `MFA_SETUP_PHASE='0'` and refire (field VISIBLE + enforced, together). Full
> detail + the impossibility of a half-flip: `deploy/MFA-SETUP-TOGGLE.md`.

SUPER ADMINS (LI-7 — R12, UNSCOPED, MFA mandatory; INTERACTIVE hidden password,
stored hash-only — never in repo/config/env, never printed; enrol each printed
otpauth, shown once). `admin@taifamining.tz` is a SUPER ADMIN — **not** an R11
user — in addition to Kira's railgrid account. The owner-role DB password lives
ONLY in `/etc/hcmos/hcmos.env` (systemd's EnvironmentFile) — a bare `node` in a
shell misses it and fails Postgres auth, so use the `hcmos-run` wrapper (sources
the env file, cd's to /opt/hcmos):
```
UAT_COMPANY=11111111-1111-1111-1111-111111111111 hcmos-run node scripts/provision-super-admin.js mohammed@railgrid.tz
UAT_COMPANY=11111111-1111-1111-1111-111111111111 hcmos-run node scripts/provision-super-admin.js admin@taifamining.tz
```
(Equivalent by hand: `cd /opt/hcmos && set -a; . /etc/hcmos/hcmos.env; set +a`
first, then the plain `node …` commands.)

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

### 7a. Employee master — populate the directory FIRST
The directory/leave/overview screens read the `employee` table; load the real
master **before** balances so leave attaches to real records. Drop
`northmara-employee-master.csv` (headers `pf,name,site,position,department,
hire_date,national_id,tin,bank`) into `/root/uat-data` — **PII (national_id/tin/
bank), NEVER the repo.** The deploy auto-loads it when present (maker Omar R15 /
checker Viswa R16, independent control = 285 North Mara headcount) and prints
counts only. By hand:
```
echo '[{"site":"North Mara","count":285}]' > /root/uat-data/northmara-employee-master.control.json
UAT_COMPANY=11111111-1111-1111-1111-111111111111 hcmos-run node scripts/load-ingest.js \
  employee-master /root/uat-data/northmara-employee-master.csv \
  /root/uat-data/northmara-employee-master.control.json \
  omar.omar@taifamining.tz viswa.medhuru@taifamining.tz --commit
```
Directory-visible: **name / position / department / site**. **national_id is
HR-visible** (Kira 2026-07-09: core HR identifier, not financial — profile-level
for `a3.national_id.roles`, default R03/R04/R07/R11). Pay-gated (R07/R11/R15/R16
only): **tin / bank / pay**. Blank national_id (45 rows) + blank position (1 row)
load anyway as a completeness punch-list (warnings, not blocks).

**Scaffold purge (Kira-authorized 2026-07-09):** before the master loads, the
deploy runs a North-Mara-ONLY, audited purge of the synthetic seed rows
(`scripts/purge-nm-scaffold.js`) so the real 285 ARE the directory. Fail-closed:
only position-NULL rows with a non-numeric/absent legacy_id and NO app_user
link; one transaction, re-verified row-by-row, on the audit hash-chain;
idempotent (re-runs delete nothing).

**Smart parsing (intelligent on format, uncompromising on truth):** the loader
auto-detects the header row (even buried under merged title rows) and maps
common header variants (EMPLOYEE ID / Payroll No → pf, FULL NAME → name, DATE
ENGAGED → hire_date, NIDA NO → national_id, …) — no manual column mapping. It
**fails closed on genuine ambiguity**: two columns claiming one field, or a
required column it cannot find, refuse with a report — never a guess. Format
anomalies (TIN not 9 digits, NIDA not 20 digits, future hire dates, one NIDA/TIN
shared by two rows) are **flagged on the punch-list and loaded verbatim** —
values are never "corrected". Duplicate PFs and unknown sites remain hard
exceptions.

### 7b. Opening balances — now ATTACH to the master by PF
Drop the **opening balances + permit files** (CSV) on the box, prepare a
`control.json` with the EXPECTED totals **from the source document** (independent
check), then load through the ingestion discipline via the loader. A balance
whose PF is in the master **attaches** to that employee (no duplicate); an
unmatched PF reports as `no employee match`:
```
cd /opt/hcmos; set -a; . /etc/hcmos/hcmos.env; set +a
# dry-run first — prints clean/exception split + control check, loads NOTHING:
node scripts/load-ingest.js opening-balance balances.csv control.json \
     omar.omar@taifamining.tz viswa.medhuru@taifamining.tz
# review balances.csv.exceptions.json, then commit (maker = Omar R15, checker = Viswa R16):
node scripts/load-ingest.js opening-balance balances.csv control.json \
     omar.omar@taifamining.tz viswa.medhuru@taifamining.tz --commit
# permits mirror (control.json = {"count": N}):
node scripts/load-ingest.js permits permits.csv permits-control.json \
     omar.omar@taifamining.tz viswa.medhuru@taifamining.tz --commit
```
Balances land in the protected **opening bucket** (lapse-exempt). Verify with
`bash deploy/smoke-test.sh`, then log in as the Head of HR (R11) account and confirm the
directory shows the loaded employees. **Stays TEST data** — carry policy +
duplicate-file open with Baraka (`deploy/RATIFY-AT-UAT.md`).

## Acceptance (I-1..I-6)
| ID | Met by |
|----|--------|
| I-1 | Step 5 (reachable, TLS, Access-gated) |
| I-2 | Step 1 (Frankfurt/DE recorded — Kira decision after no-NL-in-catalogue; production-residency caveat in the waiver) |
| I-3 | Steps 2–3 (firewall; scram + localhost Postgres) |
| I-4 | Step 3 (generated secrets; NODE_ENV=production; token not in repo) |
| I-5 | Steps 4 + 7 (HR account sees real employees + permit alerts) |
| I-6 | Step 6 (nightly off-box backup + tested restore) |

Deploy from a **CI-green** commit (the branch is green — the workflow is the gate).
