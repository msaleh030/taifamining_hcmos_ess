# HCMOS + ESS — Readiness Checklist & Coverage Map

## STEP 3 · FLOW 1 — Authentication: KIT + DESIGN delivered (`HCMOS Auth Flow.html`)
**Kit locked:** 8-state pattern · 4 themes (Light · Dark · Liquid Glass · **Reduced-transparency**) · 4 surfaces (Desktop · Tablet · Mobile · **Kiosk**, reduced/kiosk prioritised) · lifecycle enum (active · suspended · terminated · rehire) — all reusable, switchable on one stage.
**Rows now GREEN on every design column** (states ✓8 · themes ✓4 · surfaces ✓4 · EN+SW ✓ · rule annotated with lockout **[TBC]** flagged ✓ · ACs mapped ✓):

| Row | Screen | States | Themes | Surfaces | EN+SW | Rule | ACs | Verdict |
|--|--|--|--|--|--|--|--|--|
| C1 | Console MFA login | ✓ all 8 | ✓ 4 | ✓ 4 | ✓ | ✓ lockout [TBC] | AUTH-01/03/04/06 | **GREEN (design)** |
| E1 | Field PIN login (device-bound) | ✓ all 8 | ✓ 4 | ✓ 4 | ✓ | ✓ lockout [TBC] | AUTH-02/03/04 | **GREEN (design)** |
| — | Password reset (session-kill) | ✓ all 8 | ✓ 4 | ✓ 4 | ✓ | ✓ | AUTH-05 | **GREEN (design)** |
| — | PIN reset (permitted owner, session-kill) | ✓ all 8 | ✓ 4 | ✓ 4 | ✓ | ✓ | AUTH-05 | **GREEN (design)** |
| — | Role landing R01–R13 (least privilege) | ✓ | ✓ 4 | ✓ 4 | ✓ | ✓ A2 | AUTH-06 | **GREEN (design)** |

States drawn: empty · loading · populated · large-data (tenant / shared-kiosk picker) · error (generic, no factor revealed) · no-permission (terminated console / unregistered device) · offline (console blocked; field works offline + sync) · success.
**Carried to Claude Code (Section 17, not drawable):** server session creation/scoping (AUTH-01), server block of terminated user (AUTH-04), session invalidation on reset (AUTH-05), lockout-policy value [TBC]. These keep the *production* rows non-green until the data layer lands; the **design** is accepted.

---

Tracks against Acceptance Criteria Pack RTL/ACP/TM/001/2026 **incl. Addenda A1 (roles), A2 (landing/modules), A3 (confidential-field visibility)**. No visual design started; this is the inventory + mapping (Steps 1–2).

## How to read this
- **States** (AC-UNI-01): `E`mpty · `L`oading · `P`opulated · large-`X` · e`R`ror · `N`o-permission · `O`ffline · `S`uccess. A cell lists which are currently drawn.
- **Themes/Surfaces** (AC-UNI-03): themes = Light · Dark · **Liquid Glass** · Reduced-transparency; surfaces = Desktop · Mobile · Tablet · Kiosk.
- **EN+SW** (AC-UNI-07): chrome dictionary exists; per-string content + validation/error/empty strings not yet localised.
- Status: `✓` complete · `◐` partial · `✗` absent. **A row is "done" only when every column is `✓`.**

## Canonical role set (Addendum A1) — RATIFIED, 11-role assumption retired
Twelve console roles + Employee:
`R01` Supervisor · `R02` Superintendent · `R03` Project Manager · `R04` Head of Department · `R05` HR Officer · `R06` Project HR · `R07` Head of HR · `R08` Payroll Officer · `R09` Finance Manager · `R10` SHEQ Manager · `R11` COO/CEO · `R12` IT/System Admin · **`R13` Employee (ESS)**.
Reconciled in-app: confidentiality matrix now derives from this set (enumerates R01–R12). Still to reconcile outside prototype: RLS policies (enumerate R01–R13) and proforma backend-licence line (relabel 10 → 12; seats stay headcount-driven **[confirm]**, price unchanged).

### v1.5 role-model update — see `HCMOS - v1.5 Role Parity Sheet.html` (gates PR #1)
Registry v1.5 (LI-2/3/4/5/6) materially changes the role set. Design half **accepted**:
- **NEW `R14` CEO / Executive** — read-only, org-wide dashboards + reports only; **no individual pay/bank anywhere** (aggregates only); not site-scoped. Drawn into C2 (`wf-flow.js`) — wage-bill/liability shown as labelled aggregates, approvals action surface removed. ✓ green (LI-3/LI-6).
- **CHANGED `R03` HR Officer** — gained clinic/medical/permits; medical + permit views confirmed (C12/C5). **LI-5 OPEN** (HR-sees-medical pends Kira ratify) → marked **pending**, not final.
- **NEW `R15` Finance Manager + `R16` Chief Financial Controller** (replace old Finance Officer/Payroll Manager) — both see pay/bank in the **registers/catalogue (C16/C17), directory-DENIED** (C4). ✓ green (LI-2).
- **RETIRED (app-dead):** `R10` Clinic → R03 · `R08` Finance Officer → R15 · `R09` Payroll Manager → R16. No screen routes to them — confirmed. ✓
- **DEFERRED (scope-gated on Kira):** ingest maker-checker surfaces (upload→dry-run→submit / approve, exception report, same-user-refused). Held deferred-not-missing; C18/C19 pattern reusable on a "yes".
> v1.5 R-numbers are the **registry** numbering and differ from the prototype's earlier internal A1/A2 indices — the parity sheet is the reconciliation of record; align RLS enums + confidentiality matrix to the v1.5 set.

## Confidential-field visibility (Addendum A3) — source of truth for C5
- **Pay / bank** → R07, R09, R11 only.
- **Medical / permits** → R05, R06, R10 only.
- **Disciplinary** → R05, R06, R07, R11 only.
All other roles: field **absent** (not a masked placeholder), enforced server-side (AC-EMP-01 / AC-UNI-04).

---

## A. Screen inventory — CONSOLE (Desktop) · Roles per Addendum A2

| # | Screen | Roles (A2) | States drawn | Themes (4) | Surfaces (4) | EN+SW | Rule annotated | ACs mapped | Row |
|--|--|--|--|--|--|--|--|--|--|
| C1 | Login (MFA) | R01–R13 | drawn in **HCMOS Auth Flow.html** (8-state kit) | L D **G R** | **Desk Tab M K** | ✓ | ✓ MFA + lockout + session kill (AUTH-01/03) | AUTH-01/03/06 | ✓ (Auth flow) |
| C2 | Workforce Overview (console landing) | R01–R12 (R03,R06 site-scoped) | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ role-scoped landing (AUTH-06) · site-scoped roles see only their sites (A2) · KPI-ref strip · R13→ESS home | UNI-01, KPI-ref, AUTH-06 | ✓ |
| C3 | KPI Scorecard (role-scoped) | R01–R12 | empty, loading, populated, large-data, error, no-perm, offline, success, **not-available**, **flag-off** | L D **G R** | **Desk Tab M K** | ✓ | ✓ role-scoped set (A2/A3) · value/formula/target/RAG per card · live from slices 2–6 · On/Watch/Off counts consistent · **N/A names the input** (LIAB-03) · leavers excluded (LVR-02) | KPI-01/02/03/04, LIAB-03, LVR-02 | ✓ |
| C4 | Employees directory | R02–R07 (R03,R06 site-scoped) | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ site-scoped (EMP-02) · 5k virtualised (UNI-02) · lifecycle badges | EMP-02, UNI-02 | ✓ |
| C5 | Employee profile (drawer) | R02–R07 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ confidential fields **absent-not-masked** by role (A3 · EMP-01) · edit routes to approval (EMP-03) | EMP-01/03, SOD-03 | ✓ |
| C6 | New joiner modal | R05,R06,R07 (expat R07,R11) | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ number **generated TMCL-&lt;LOC&gt;-&lt;SEQ&gt;** non-editable, resets/loc · **[TBC-ROLLOVER]** flagged | JML-01/03/04 | ✓ |
| C7 | Transfer modal | R02–R07 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ site+role change, **number unchanged** (MOV-01 · EN-4) | MOV-01 | ✓ |
| C8 | Disciplinary modal (warning/suspension + fan-out) | issue: R05,R06,R07,R11 + line mgr R02 [A2] | empty, drafted, loading, success, error, no-perm, **self**, offline | L D **G R** | **Desk Tab Mob Kiosk** | **✓ EN+SW** | ✓ fan-out · SoD visible · DISC-02 mgr-resolve | DISC-01/02/03/04 · SOD-01/02 · UNI-06 | **✅** |
| C7b | **Rehire** (returning employee) | R05,R06,R07 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ prior record matched · **original number retained (no new mint)** · history re-linked · status terminated→rehired | **MOV-02** | ✓ |
| C9 | ID card modal (print) | R02–R07, R12 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** (print=light) | **Desk Tab M K** | ✓ | ✓ permitted fields only · confidential never printed · ID no. **TMCL-&lt;LOC&gt;-&lt;SEQ&gt;** | PRT-01 | ✓ |
| C10 | Leave & Attendance (approve + coverage) | R01,R02,R03,R05,R06,R07 | empty, loading, populated, large-data, error, no-perm, offline, success, **coverage-warn** | L D **G R** | **Desk Tab M K** | ✓ | ✓ LR-6 coverage **warn-not-block** + audited override · matrix/SoD unchanged (SOD-01) | LV-03, UNI-06 | ✓ |
| C11 | Performance & Recruitment | R01–R07 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ appraisals feed KPI · recruitment sign-off per SoD (SOD-01) · **site-bound roles (R03/R06) see appraisals + recruitment funnel for their site only (Mwadui); org-wide R07+ see all sites — funnel inherits the site-scope of the people it covers** | KPI-ref, EMP, SOD-01, **site-scope R03/R06** | ✓ |
| C12 | HSEQ | R10 manage (+R07) · R01–R12 read-only | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ register+**LTI flag** (SQ-1) · inspections/permits/**report set** (SQ-2) · env/occ-health/PPE (SQ-4) · NCR+**WCF/incident routing** (SQ-5) · capture-form + competency **[SQ-3 Open]** — field set + framework pending, **not invented** | SQ-1/2/4/5 ✓ · **SQ-3 [Open]** · DOC, UNI-06 | ✓ |
| C13 | Training | R01,R02,R04,R05,R06,R07,R10 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ request→approve(**maker≠checker SOD-01**)→session→cert(**expiry→DOC-01**)→matrix(**feeds completion KPI**) | **TRN-01..05** | ✓ |
| C14 | Grievances | R03,R05,R06,R07 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ lifecycle raised→investigating→resolved · **officer ≠ subject/respondent** (SOD-01) · confidential to officer+HR (A3) | SOD-01 | ✓ |
| C15 | Approvals | R01,R02,R03,R04,R07,R09,R11 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ maker-checker queue · **requester (maker) ≠ approver (checker)**, SoD server-side (SOD-02) | SOD-01/02/03 | ✓ |
| C16 | Payroll / leave liability | R08,R09 (liability view R07,R08,R09,R11 [A3]) | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ daily = **leave-pay base ÷ 30** (PC-1) · base = monthly **excl. Rotation + Night-Shift allowances + variable overtime (EX-2, v1.4 — no [TBC])** · active-only (LVR-02) · **NOT-AVAILABLE names the missing input** (LIAB-03) | LIAB-01/02/03 | ✓ |
| C17 | Reports + preview | R01–R12 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ generate + **PRT-02 preview** (A4 light) · Total Pay / Net Pay wording · **a report inherits the gate of the data it exposes: financial/org registers (Payroll, Leave-liability) offered to pay-visibility roles only (R07/R08/R09/R11) — NOT offered to site roles, matching C16 (a site-scoped payroll report would still leak salaries to a role entitled to none); operational reports (Headcount, Attendance) site-scoped for R03/R06 (Mwadui only) matching C2/C4, preview swaps to non-financial headcount** | PRT-02, **gate-inherits-data**, pay=C16 | ✓ |
| C18 | Exact Integration (schema · reconcile · control-totals · publish) | R07,R08,R09,R12 | empty, loading, populated, large-data, error, no-perm, offline, success, **validation-failed**, **totals-mismatch**, **partial-publish** | L D **G R** | **Desk Tab M K** | ✓ | ✓ upload→schema→reconcile→control-totals→publish · **match key = legacy_id** (resolved · client-confirmed) · validation-fail + totals-mismatch **block publish** (safety net) · unmatched held, leaver excluded (LVR-02) · publish uses **Total Pay / Net Pay** · **partial fan-out: GL-posted / ESS-push-failed shown per leg, scoped re-push of failed leg only — no blind re-publish (no GL double-post)** | **EXACT-01..10** | ✓ |
| C19 | Data Migration | R07,R12 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ upload→validate→map→commit · **legacy TMC-##### → TMCL-&lt;LOC&gt;-&lt;SEQ&gt;**, identity preserved (EN-6 · JML-02) | JML-02, TEN | ✓ |
| C20 | Security & Access + **Controls & Checker** | **Controls: R11,R12 (R07 refused)** · Security: R07,R12 | empty, loading, populated, **all-clear**, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ **Controls & Checker (AUD-03)**: SoD breach · attendance-without-GPS · leaver-access · audit-chain integrity — **fail-with-offenders grid (per-control offending records) AND all-clear evidence grid (every control green WITH its checked-count, provable not asserted)**, run itself audited (UNI-06) | AUD-01/02/**03**, SOD-02, LVR-01 | ✓ |
| C20b | **Expiry-alert configuration** (DOC-01) | R05,R06,R07,R11,R12 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ **DA-1 lead times** (90/60/30/7) · **DA-2 notified role** · set / repeat / clear · active + cleared alert states · clearing audited (UNI-06) | DOC-01 | ✓ |
| C21 | Organization & Settings + **Tenant provisioning wizard** | R07,R11,R12 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ **8-step wizard** mints `company_id`, seeds roles (R01–R13) + matrix + sites/codes + leave types + doc types + KPI catalogue/targets + statutory params **from registry config, no manual DB step** · review/confirm · **atomic provision (success)** + **rollback (error, no half-tenant)** · repeatable · _[known secondary state, deferred to wizard F-slice: pre-provision rejection (tenant code/name collision, invalid currency/country) at Identity step — low-likelihood as codes are registry-minted; atomic-rollback net already covers mid-provision failure]_ | **TEN-01/02/03** | ✓ |
| C22 | **Asset module** | R07,R12 (asset-owner [TBC]) | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Desk Tab M K** | ✓ | ✓ register · assign · return · custody history · **leaver-clearance flag** (ASSET-05) · **scope-bounded on-screen: no depreciation/maintenance/procurement/QR** | **ASSET-01..07** | ✓ |
| C23 | Mobile app (manager ESS) | R01–R12 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Mob** · Desk Tab K | ✓ | ✓ approvals + team-on-shift from mobile · ESS mirrored (UNI-01) | mirrors ESS rows | ✓ |

## B. Screen inventory — ESS (Mobile) · R13, mirrored to R01–R12 via C23

| # | Screen | Roles | States drawn | Themes | Surfaces | EN+SW | Rule | ACs | Row |
|--|--|--|--|--|--|--|--|--|--|
| E1 | PIN login (field) | R13 | drawn in **HCMOS Auth Flow.html** (8-state kit) | L D **G R** | **Mob** · Tab K | ✓ | ✓ device-bind PIN + lockout + reset (AUTH-02/03/05) | AUTH-02/03/05 | ✓ (Auth flow) |
| E2 | Home | R13 (+R01–R12) | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Mob** · Desk Tab K | ✓ | ✓ greeting + clock chip + quick actions + activity feed + outstanding (A2 landing) · offline shows last-synced | UNI-01, AUTH-06 | ✓ |
| E3 | Clock in/out (+ geofence + offline) | R13 (+R01–R12) | empty, loading, success, error, **low-accuracy**, no-perm, **offline**, **large-data**, **conflict** | L D **G R** | **Mob** ESS · **Kiosk** assisted · Desk Tab | ✓ | ✓ device-side capture · **three-way geofence outcome: within (names zone) / outside / accuracy-too-low (±140 m > ±100 m tolerance → hold + retry, not a rejection)** · server re-validates on sync · offline queue+dedupe by idempotency key · sync-conflict resolution · geofence radius **[SS-3 Open]** flagged | ATT-01/02/03 · **UNI-01 offline** · **UNI-06** | ✓ |
| E4 | Apply leave (balance/overlap/14-day + sick) | R13 (+R01–R12) | empty, loading, populated, large-data, error, no-perm, **offline**, success, **sick-leave** | L D **G R** | **Mob K** ESS · Desk Tab | ✓ | ✓ blocks at submit on over-balance/overlap/**>14 continuous** (LR-5) + HoH exception path · sick separate tile 63+63 + **cert from day one** (LR-7) · carry lapses 1yr (LR-4) | LV-01/02/05, LR-1/2/4/5/7 | ✓ |
| E5 | Documents | R13 (+R01–R12) | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Mob** · Desk Tab K | ✓ | ✓ payslips/contract/certs/ID · confidential (warning) **restricted-not-shown** (A3) · offline download queued | DOC, PRT-02, A3 | ✓ |
| E6 | Payslip | R13 (+R01–R12) | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Mob** · Desk Tab K | ✓ | ✓ **Total Pay** · **Net Pay (Total Pay minus Total Deduction)** — no "Total Allowance" · in-app only | PRT-02 | ✓ |
| E7 | Policies (read · acknowledge · re-acknowledge) | R13 (+R01–R12) | empty, loading, populated, large-data **(publish/outstanding admin-gated R07/R11; non-admin → lock)**, error, no-perm, offline, success | L D **G R** | **Mob** · Desk Tab K | ✓ | ✓ read current version · acknowledge · **re-acknowledge on new version** (POL-03) · **outstanding tracking** roll-up (POL-04) | **POL-01..04** | ✓ |
| E8 | Performance / My KPIs | R13 (+R01–R12) | empty, loading, populated, large-data, error, no-perm, offline, success, **not-available**, **flag-off** | L D **G R** | **Mob** · Desk Tab K | ✓ | ✓ personal role-scoped set · value/formula/target/RAG · N/A names input (LIAB-03) | KPI-04, LIAB-03 | ✓ |
| E9 | Training | R13 (+R01–R12) | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Mob** · Desk Tab K | ✓ | ✓ raise request (offline-queued) · routes to manager · cert + expiry in ESS | TRN-01 (ESS) | ✓ |
| E10 | Notifications | R13 (+R01–R12) | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Mob** · Desk Tab K | ✓ | ✓ unread tracking · mark-read · **ESS↔HCMOS synced** (UNI-01) · offline last-synced | UNI-01 | ✓ |
| E11 | ID card (digital) | R13 (+R01–R12) | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Mob** · Desk Tab K | ✓ | ✓ **permitted fields only**, confidential never printed (A3) · QR verify, **offline-capable** · ID no. **TMCL-&lt;LOC&gt;-&lt;SEQ&gt;** | PRT-01 | ✓ |
| E12 | Support / tickets (raise → lifecycle → closure → notify) | R13 (+R01–R12) | empty, loading, populated **(agent transition vs read-only)**, large-data **(agent → full queue; non-agent → own-tickets scope)**, error, no-perm, offline, success | L D **G R** | **Mob** · Desk Tab K | ✓ | ✓ raise → 5-stage lifecycle to closure · notify raiser on every state change (SUP-01..04) | **SUP-01..04** | ✓ |
| E13 | Profile gate (incomplete) | R13 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Mob** · Desk Tab K | ✓ | ✓ required-field checklist + progress · blocks ESS until complete · **success unlocks** (UNI-01) | UNI-01 (no-permission) | ✓ |
| E14 | Suspended / blocked | R13 | empty, loading, populated, large-data, error, no-perm, offline, success | L D **G R** | **Mob** · Desk Tab K | ✓ | ✓ **suspended** (DISC-03) vs **terminated/closed** (LVR-01) blocks, distinct · ESS paused, contact HR | AUTH-04, LVR-01, DISC-03 | ✓ |

**Result: ESS rows E2–E14 green (E1 field-PIN login carried to the Auth flow). Every delivered row now carries 8 states · 4 themes (incl. Glass + Reduced) · 4 surfaces · EN+SW · rule annotated · ACs mapped.**

---

## C. Criterion → screen coverage map

| AC | Screen(s) | Status |
|--|--|--|
| UNI-01 states | ALL | ◐ only P/S, some E · **E3 full 8-state + offline queue/sync/conflict ✓** |
| UNI-02 large-data | C4, C20 (pager) | ◐ no 5k virtualise · **E3 kiosk roster 5,214 virtualised ✓** |
| UNI-03 themes/surfaces | ALL | ◐ 2/4 themes, 2/4 surfaces |
| UNI-04 server authz | — | ✗ backend |
| UNI-05 tenant isolation | — | ✗ backend; single-tenant |
| UNI-06 audit on change | C20, **E3** | ◐ client hash-chain · **E3 punch/sync/conflict audited** |
| UNI-07 bilingual | ALL | ◐ chrome only |
| UNI-08 input validation | forms | ◐ minimal |
| AUTH-01 MFA login | C1 | ✗ MISSING |
| AUTH-02 PIN device login | E1 | ✗ MISSING |
| AUTH-03 bad creds/lockout | C1/E1 | ✗ MISSING [TBC] |
| AUTH-04 terminated blocked | E14 | ◐ "Terminated" status not modelled |
| AUTH-05 reset + session kill | — | ✗ MISSING |
| AUTH-06 role landing | C2 | ◐ landings exist (A2) |
| EMP-01 confidential by role | C5 | ✓ absent-not-masked by role (A3); UI |
| EMP-02 site scoping | C4 | ✓ site-scoped directory |
| EMP-03 approval on change | C5 | ✓ write-back loop (UI) |
| JML-01..04 | C6/C19/C20 | ◐ no.fmt **TMCL-&lt;LOC&gt;-&lt;SEQ&gt;**; [TBC-NYZ]/[TBC-ROLLOVER] |
| MOV-01 transfer identity | C7 | ✓ site/role change, number unchanged (new fmt) |
| JML-02 migration identity | C19 | ✓ legacy TMC-##### → TMCL-&lt;LOC&gt;-&lt;SEQ&gt; on migrate, identity preserved |
| MOV-02 rehire keeps number | C7b | ✓ original number retained, no new mint, history re-linked |
| LVR-01/02/03 | C20/E14/C2 | ◐ leavers not excluded from KPI pops |
| LV-01..06 | C10/E4 | ✓ LR-1 entitlement (7×7×7/8-2/9-3) · LR-2 30-day basis · LR-4 carry lapse · LR-5 14-continuous+HoH · LR-6 coverage warn+override · LR-7 sick 63+63+cert |
| LR-7 sick leave | E4 | ✓ separate tile, cert-required-on-submit from day one |
| LIAB-01/02/03 | C16 | ✓ daily=monthly÷30 (PC-1) · active-only (LVR-02) · NOT-AVAILABLE names missing input |
| DISC-01..04 | C8 | ◐ fan-out ✓; SoD partial |
| SOD-01/02/03 | C15/C5/C14 | ✓ maker-checker (requester≠approver), grievance officer≠subject; UI + rule annotated (server carried) |
| AUD-01/02 chain | C20 | ◐ client |
| AUD-03 Controls & Checker | C20 | ✓ controls run pass/fail with offending records (SoD, no-GPS attendance, leaver access, chain integrity); **all-clear evidence grid = each control + checked-count**; run audited; **gate = Compliance/IT (R11,R12); Head of HR (R07) refused — not general HR seniority** |
| ATT-01/02/03 | E3 | ✓ capture + geofence pass/fail + **offline queue/sync/conflict** drawn; SS-3 boundary radius **[Open]** flagged (field+rule on placeholder, value unresolved) |
| KPI-01/02/03 | C3 | ✓ role-scoped, live from slices 2–6, value/formula/target/RAG, On/Watch/Off counts consistent, N/A names input; **module flag-off state (disabled panel, no cards/RAG/counts) distinct from empty & no-perm** |
| KPI-04 ESS scorecard | E8 | ✓ personal set, live, N/A drawn |
| DOC-01 expiry alerts | C12/C20 | ✓ lead times (DA-1) + notified role (DA-2) + set/repeat/clear; active & cleared states |
| **TRN-01..05 Training** | C13 (+E9) | ✓ request→approve(SoD)→session→certificate(expiry→DOC-01)→competency matrix(→completion KPI); 8 states · 4×4 · EN+SW |
| **EXACT-01..10 Exact integration** | C18 | ✓ schema-validate + reconciliation (unmatched held) + control-totals (mismatch blocks publish) + publish-back; match key = legacy staff no. [TBC] |
| **SUP-01..04 Support** | E12 (+C20 desk) | ✓ raise → lifecycle to closure → notify at each step; **own-tickets scope for non-agents; full queue + transitions = agents (R12) / HR admins (R07,R11)** |
| **POL-01..04 Policies** | E7 | ✓ read + acknowledge + re-acknowledge on new version + outstanding tracking; **publish + org-wide outstanding admin-restricted (R07/R11); plain employee blocked** |
| **ASSET-01..07 Asset module** | C22 | ✓ register/assign/return/custody + leaver-clearance flag; scope-bounded (no deprec/maint/procure/QR); **owner role [TBC]** |
| TEN-01 provisioning wizard | C21 | ✓ 8-step wizard seeds all config from registry (no manual DB step); **provisioned state names new `company_id` + seeded counts + RLS-isolation note**, atomic-rollback state distinct (no half-provisioned tenant); repeatable |
| TEN-02 tenant isolation | C21 | ✓ fresh `company_id` minted & RLS-keyed from the first seed (design) |
| PRT-01 ID card | C9/E11 | ✓ permitted fields only, confidential never printed; ID no. **TMCL-&lt;LOC&gt;-&lt;SEQ&gt;** |
| PRT-02 letter/payslip | C17/E6 | ✓ generate + A4 light preview (C17); payslip Total Pay / Net Pay (E6) |

## D. Missing screens raised (no screen satisfies the criterion)
1. Console MFA login (AUTH-01/03). 2. Field PIN login + device binding (AUTH-02). 3. Password/PIN reset + session kill (AUTH-05). 4. ~~Controls & Checker module (AUD-03)~~ **— DESIGNED, C20 (Slice 9)**. 5. ~~Tenant provisioning wizard (TEN-01)~~ **— DESIGNED, C21 (Slice 10)**. 6. ~~Offline states + clock-in queue/sync (UNI-01 offline, ATT-02)~~ **— DESIGNED, E3 (Slice 5)**. 7. Rehire flow (MOV-02). 8. ~~Document-expiry alert config + repeat/clear (DOC-01)~~ **— DESIGNED, C20 (Slice 9)**. 9. Liquid Glass + reduced-transparency themes (UNI-03) — global. 10. Tablet + Kiosk surfaces (UNI-03) — global. 11. ~~Large-data (5,000+) virtualised lists (UNI-02)~~ **— DESIGNED across slices 5–10**. 12. ~~"Not-available (input X missing)" KPI/liability state (LIAB-03)~~ **— DESIGNED, C3/C16 (Slices 6–7)**.

## E. Behaviours with no covering criterion (still to confirm or descope)
- Organogram view and the config registry **beyond** the TEN-01 provisioning seed list (Org & Settings) — confirm intended ACs or descope. *(Training, Exact, Support, Policies, Assets now mapped — removed from this list.)*

## F. [TBC] values — design field + rule, leave value unresolved
**Employee number (supersedes EN-1, governance 29 Jun 2026):** format now **TMCL-&lt;LOC&gt;-&lt;SEQ&gt;** (no year), LOC {HO,MW,NM,NZ}, SEQ 4-digit zero-padded, **resets per location**. Drawn generated + non-editable across C6/C7/Rehire/C9/E11 and directory/profile. **[TBC-NYZ] RESOLVED 29 Jun — sample ID table is source of truth: Nyanzaga = NZ.** Two values left open: **[TBC-ROLLOVER]** behaviour beyond 9999 per location · **[TBC-COMPANY-SEGMENT]** company prefix segment. C6/C7/C9/E11 number field in **review** until both confirmed.
Lockout policy (AUTH-03) · LR-2 day conversion · LR-4 carry limit (now "lapses after 1 year") · LR-5 max continuous (14 continuous w/ HoH-override) · LR-6 coverage · PC-1 divisor · PC-3 gross composition · DA-1 lead times · ~~SS-1 site boundary~~ **SS-3 geofence zones CONFIRMED v1.1 (multi-zone/site, in-ANY-zone valid, server re-validated; HO coords still [OPEN]; ZKTeco @ Mwadui Production [TBC]; accuracy-tolerance [confirm])** · ES-1 PIN owner · **Exact export spec (EXACT)** · **Asset-owner role (ASSET)** · **Competency steps (HSEQ/C12)** · Licence seat count [confirm].
