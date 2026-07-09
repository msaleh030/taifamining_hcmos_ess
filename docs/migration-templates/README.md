# HCMOS data-migration templates — the authoritative contract

**Purpose.** Every inconsistency we hit in the real files — payroll numbers typed
as `"HO"`, one shared mailbox standing in for 361 personal logins, a job title in
the "Reporting To" column, dates stored as Excel serial numbers, the header
buried under merged title rows, names split three ways — is a **capture** problem,
not a load problem. You cannot enforce alignment after the fact; you enforce it at
the point of capture. **The template is that point of authoritative control.**

One template per module. The data owner fills the template. The loader validates
every row against the template's contract and **refuses to guess** — so what
reaches the box is exactly what the template guarantees, and nothing else.

## The five control gates (every module, no exceptions)

1. **Canonical columns.** The template's headers are the only authoritative names.
   The loader recognises common variants (`Payroll No.` → `pf`, `Company Email ID`
   → `email`) so existing exports still load, but the template is what everyone
   fills so variants stop appearing.
2. **Strict formats, validated on load.** Numeric PF, 20-digit NIDA, 9-digit TIN,
   `YYYY-MM-DD` dates (never Excel serials), controlled site/type lists. A format
   anomaly is **flagged on the punch-list and loaded verbatim** — we never "fix" a
   value. A structural violation (non-numeric PF, unknown site) is a **hard
   exception**.
3. **Independent control totals.** Alongside every data file, a tiny `control.json`
   states the EXPECTED per-site headcount / sum, taken from the **source
   document**, not derived from the file. The commit **hard-blocks** unless the
   clean rows reconcile with it. This is the single most important gate: it is how
   you assert "authoritative control of what you upload."
4. **Maker–checker.** A maker (Finance Manager, R15 — Omar) submits; a **different**
   person (CFC, R16 — Viswa) approves. Neither can be both.
5. **Dry-run first, then atomic commit.** Every load previews — clean/exception
   split + an exceptions report written next to the file — and **writes nothing**
   until you approve. The commit is one transaction: all rows or none.

## Golden rules for filling a template (share with site HR)

- **One row per person/record.** No merged cells, no blank spacer rows, no totals
  row inside the data.
- **Header on its own row.** Title/branding rows above it are fine (the loader
  auto-detects the header), but the header names must match the template.
- **PF is mandatory, numeric, unique company-wide.** Never a placeholder
  (`HO`, `N/A`, `-`) and never blank. A person without a payroll number is not
  ready to migrate — get the number first.
- **Dates as text `YYYY-MM-DD`.** Format the column as *Text* before typing, or
  Excel will silently store a serial number.
- **Email is the ESS login: personal and unique, or blank.** Never a shared
  mailbox (`hr-site@…`, `main@…`, `NIL`). A shared address cannot be a login;
  leave it blank until a real one exists.
- **"Reporting To" is the manager's PF**, not a job title. It must match another
  row's PF. If you only know the title, leave `reporting_to_pf` blank and put the
  title in `reports_to_title` — the organogram then shows the position, not a
  fabricated person link.
- **Blanks are allowed on optional fields** and become a completeness punch-list
  (loaded, flagged) — not a reason to invent data.

## Confidentiality tiers (who sees what — enforced server-side)

| Tier | Fields | Visible to |
|---|---|---|
| **Directory** | pf, name, site, position, department, level, email | everyone with directory access |
| **HR** | national_id | R03/R04 HR + payroll (`a3.national_id.roles`) |
| **Pay / PII** | tin, bank_*, passport, work_permit, nssf, dob, gender, address, next_of_kin | R07/R11/R15/R16 (`a3.pay.roles`) |

Confidential fields live in separate, separately-authorised tables — a role
without the tier never joins them, so the value is **absent**, never masked.

## The modules

| Template | Loader kind | Key | Control total |
|---|---|---|---|
| `employee-master.template.csv` | `employee-master` | `pf` | per-site headcount |
| `leave-opening-balance.template.csv` | `opening-balance` | `pf` (matches master) | per-site count + sum of balance |
| `permits-documents.template.csv` | `permits` | `pf` (matches master) | total count |

Load **employee-master first** (it is the directory the other modules attach to),
then opening balances, then permits. Each module's field dictionary is below; the
blank template + an example `control.json` sit next to this file.

Run every load through the loader (never a raw INSERT):
```
UAT_COMPANY=<uuid> hcmos-run node scripts/load-ingest.js <kind> <file.csv> <control.json> \
    omar.omar@taifamining.tz viswa.medhuru@taifamining.tz          # dry-run (writes nothing)
# review <file.csv>.exceptions.json, confirm the control totals reconcile, then:
UAT_COMPANY=<uuid> hcmos-run node scripts/load-ingest.js <kind> <file.csv> <control.json> \
    omar.omar@taifamining.tz viswa.medhuru@taifamining.tz --commit  # maker→checker, atomic
```

---

## 1 — Employee master (`employee-master`)

Populates the directory; every other module attaches to it by PF.

| Column | Req | Format / rule | Tier |
|---|---|---|---|
| `pf` | **yes** | numeric, unique company-wide | directory |
| `first_name` | **yes** | text | directory |
| `middle_name` | no | text | directory |
| `surname` | **yes** | text | directory |
| `site` | **yes** | one of: Head Office \| Mwadui \| North Mara \| Nyanzaga | directory |
| `position` | **yes** | job title | directory |
| `department` | no | text | directory |
| `level` | no | text | directory |
| `employment_type` | no | Permanent \| Fixed Term \| Specific Task \| Contract | directory |
| `hire_date` | **yes** | `YYYY-MM-DD` | directory |
| `company_email` | no | personal + unique, or blank (the ESS login) | directory |
| `reporting_to_pf` | no | a PF that exists in this file (manager) | directory |
| `reports_to_title` | no | text (only if the PF is unknown) | directory |
| `national_id` | no | NIDA, 20 digits | **HR** |
| `date_of_birth` | no | `YYYY-MM-DD` | pay/PII |
| `gender` | no | Male \| Female | pay/PII |
| `tin` | no | 9 digits | pay/PII |
| `bank_name` / `bank_account` / `bank_branch` / `account_name` | no | text | pay/PII |
| `passport_number` / `citizenship` / `work_permit_number` / `work_permit_validity` | no | text; validity `YYYY-MM-DD` | pay/PII |
| `nssf_number` | no | text | pay/PII |
| `personal_email` / `phone` / `full_address` | no | text | pay/PII |
| `nok_relationship` / `nok_name` / `nok_contact` | no | text | pay/PII |

`control.json`: `[{"site":"North Mara","count":173}, {"site":"Mwadui","count":361}, …]`

A PF that already exists is **enriched in place** after a name+site identity check
(fills missing fields, keeps existing leave) — never duplicated. A PF match with a
*different name or site* is an exception, never an overwrite.

## 2 — Leave opening balance (`opening-balance`)

| Column | Req | Format / rule | Tier |
|---|---|---|---|
| `pf` | **yes** | numeric; should match an employee | directory |
| `name` | **yes** | full name (verifies the PF match) | directory |
| `site` | **yes** | controlled site list | directory |
| `leave_type` | no | annual (default) \| … | directory |
| `accrued` | no | days (enables the `balance = accrued − taken` check) | directory |
| `taken` | no | days | directory |
| `balance` | **yes** | days; **negative allowed** (a deficit that nets against future accrual) | directory |
| `as_of_date` | **yes** | `YYYY-MM-DD` | directory |
| `year` | no | leave year (defaults to the opening year) | directory |

`control.json`: `[{"site":"North Mara","count":173,"sum_balance":2450.5}, …]`
Balances land in the protected opening bucket (lapse-exempt).

## 3 — Permits & documents (`permits`)

| Column | Req | Format / rule | Tier |
|---|---|---|---|
| `pf` | **yes** | numeric; matches an employee | directory |
| `name` | **yes** | full name | directory |
| `document_type` | **yes** | work_permit \| residence_permit \| medical \| contract \| other | — |
| `document_name` | **yes** | text | — |
| `reference_number` | no | text | pay/PII |
| `issue_date` | no | `YYYY-MM-DD` | — |
| `expiry_date` | **yes** | `YYYY-MM-DD` (drives renewal alerts) | — |
| `permit_class` | no | expat \| business (routes the DA-2 alert) | — |

`control.json`: `{"count": 128}`

---

**Why this ends the inconsistencies.** With these templates, the four problems from
the audit cannot recur: a `PF="HO"` fails the numeric rule at capture; a shared
mailbox is never entered because the rule says "personal or blank"; a job title
goes in `reports_to_title`, never masquerading as a manager link; a serial date is
impossible when the column is `YYYY-MM-DD` text. And whatever still slips through is
caught by the control-total gate before a single row is written.
