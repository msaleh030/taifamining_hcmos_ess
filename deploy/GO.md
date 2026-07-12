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
| 3 | Ramadhan Mchomvu | R03 (site-scoped → **Nyanzaga - Sotta Mining Project**) | `ramadhan.mchomvu@taifamining.tz` |
| 4 | **Advera Speratus** (CONFIRMED — roster's 'Alvera Salvator' was wrong) | R03 **MULTI-SITE**: North Mara L&H/Airstrip **+** North Mara TSF Lift 10 (two distinct sites, `user_site_scope`) | `advera.speratus@taifamining.tz` |
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

### 7a. Employee masters — the CANONICAL SIX-SITE model (Kira 2026-07-12)
North Mara is TWO sites (projects) with independent HR scoping; the canonical
set + headcounts (total **1,044**):
| Site | Canonical | File to drop |
|---|---|---|
| Head Office | 50 | `Employee_Master_File_HO.xlsx` |
| Mwadui | 374 | `Employee_Master_File_Mwadui.xlsx` |
| North Mara - L&H and Airstrip Project | 173 | `Employee_Master_File_North_Mara.xlsx` |
| North Mara - TSF Lift 10 Project | 94 | `North_Mara_TSF_Employee_Masterfile.xlsx` |
| Nyanzaga - Sotta Mining Project | 282 | `Employee_Master_File_Nyanzaga.xlsx` |
| Dar Yard | 71 | `Master_File_Dar_Yard.xlsx` |

Drop the six ORIGINAL .xlsx files into `/root/uat-data` (**PII — NEVER the
repo**) and re-fire the deploy. Each converts on-box to the canonical template
CSV (`scripts/xlsx-to-master.js`) and loads through the audited maker-checker
ingest (Omar R15 / Viswa R16) with per-site canonical control totals.
`allow_shortfall` is set per Kira: known-bad rows (Mwadui's 9 PF="HO", Dar
Yard's 4 contractor codes, within-file dups) carry as FLAGGED EXCEPTIONS and
the gap is reported; an overshoot still hard-blocks. Reporting is SPLIT:
`reports_to_title` free text; `manager_id` links only when a `reporting_to_pf`
resolves to a real employee at the same site.

**Kira's three rulings (2026-07-12):**
1. **PF uniqueness is SITE-LEVEL.** A cross-site duplicate PF is a legitimate
   different person: it LOADS at its site, FLAGGED for correction (pending
   Head of HR approval), with the PF kept as legacy id only (`emp_no`
   unassigned — the number scheme stays company-unique). A duplicate WITHIN a
   site is still an exception.
2. **Emails are never invented.** `scripts/propose-emails.js` writes the DRAFT
   `firstname.lastname@taifamining.tz` list (collisions marked) to
   `/root/proposed-emails.csv` (600, box-only) for Taifa IT/HR to confirm;
   confirmed addresses come back through the employee-master enrich load,
   where a duplicate email is an EXCEPTION — a login is personal, never shared.
3. **Reporting lines are job TITLES by design.** The organogram
   (`GET /reports/organogram`) builds on the position hierarchy and states its
   limitation: with several same-titled managers it cannot say WHICH one a
   person reports to.

### 7a-ii. The second wave — leave / expat permits / payroll (Kira 2026-07-12)
Load ORDER is enforced by the deploy script: masters FIRST, then leave
(attaches by PF at site), then expat permits (**keyed on PF**, not name), then
payroll (behind the pay-visibility gate). Drop into `/root/uat-data`:
| File | Site / scope |
|---|---|
| `Leave_Master_File_Head_Office.xlsx` | Head Office |
| `Leave_Master_File_Mwadui.xlsx` | Mwadui |
| `Leave_Master_File_North_Mara_TSF10.xlsx` | North Mara - TSF Lift 10 Project |
| `Leave_Master_File_Nyanzaga.xlsx` | Nyanzaga - Sotta Mining Project |
| `Expat_Permits_Master_File.xlsx` | company-wide (site column passes through) |
| `Payroll_Master_File_North_Mara.xlsx` | North Mara - L&H and Airstrip Project |

KNOWN GAPS (reported every run): no leave master for North Mara - L&H and
Airstrip Project or Dar Yard. Controls for this wave are DERIVED from the
converted file (`scripts/derive-control.js`) because no independent totals
were supplied — that catches conversion/load drift, NOT source truth.

### 7a-iii. Scope rulings (Kira 2026-07-12, second)
- **CENTRAL roles** (see all sites): R04, R06, R07, R11, R12, R14, R15, R16 —
  enforced in the `site_scope` table by migrations 029/031 (upsert, durable),
  verified by a deploy checkpoint. Site-bound tier stays R01/R02/R03/R05/R13.
- **Every R03 carries an EXPLICIT multi-site set** (`user_site_scope` rows):
  singletons are made explicit at deploy; Advera Speratus holds BOTH North
  Mara projects. Fail-closed: an R03 whose set resolves empty sees nothing.
- **Expatriate CRUD is STRICTLY the Head of HR** (`expat.crud.roles` = R11):
  non-R11 can neither raise nor decide a field change on an `is_expat`
  employee, and an expat's permit documents are R11-only in the document
  list (DA-2's R11-only leg extended). R11 joined the maker tier for this
  (migration 031 amends existing tenant config). SoD (Kira): **the checker
  for an R11-raised expat change is R14** (`expat.checker.roles`) — Omid
  raises, Richard decides; the CEO set REPLACES the generic checkers for
  is_expat subjects (and R14 stays a NON-checker for locals). Bulk ingest
  (R15/R16, control-totalled) is the one sanctioned load path and is
  unchanged. Live probe fails the deploy.

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
