# Ratify-at-UAT agenda (consolidated)

Every **Applied, pending ratification** value in one place for the UAT session.
Each is a REAL value that applies now (not [TBC]-gated), is pinned by a test, and
flips via a **registry edit, not a deploy**. Do not change any of these without
Kira; a drifted value fails CI.

## A. Applied values to ratify

| # | Registry key | Applied value | Question for the client | Pinned by |
|---|---|---|---|---|
| 1 | `auth.lockout.threshold` / `.duration` | 5 attempts / 900 s | Confirm the lockout policy | `auth.test.js` |
| 2 | `doc.notify.role.*` (DA-2) | contract→R05, permit→R06, licence→**R06**, medical→**R03** (v1.5: R10 removed; reassigned per intent) | Confirm the two reassignments (licence→HSE Mgr, medical→HR Officer) | `slice9.test.js`, `slice10.test.js` |
| 3 | `policy.publish.roles` | R12 | Publish owner: IT-admin (R12) vs HR (R07)? Org RACI may differ | `f7.test.js` |
| 4 | `support.agent.roles` | R12 | R12-only vs an HR / dedicated support owner? | `f7.test.js` |
| 5 | `alerts.view.roles` | R03,R04,R05,R06,R11,R12 (v1.5: R10 dropped) | Deliberately NOT reports-scoped (R03, a DA-2 recipient, has no reports module) — ratify as-is | `f7.test.js` |
| 6 | `controls.view.roles` | R11,R12 | Confirm AUD/SOD membership (RACI may add/replace) | `f7_controls.test.js` |
| 7 | `ingest.roles` / `ingest.maker.roles` / `ingest.checker.roles` | union R15,R16; maker=R15 (Finance Manager), checker=R16 (CFC) | v1.5 LI-6: role-split SoD (disjoint maker/checker roles + same-user-403). Confirm the finance ownership (was R11/R12) | `ingest.test.js`, `load_ingest.test.js` |
| 8 | **LI-5** — HR-medical widening (v1.5) | `a3.medical.roles` = R03,R05,R06; `FIELD_RULES` medical/permits +R03 | **OPEN**: v1.5 removed the Clinic role and R03 absorbs it — this widens medical visibility to ALL HR Officers. Applied per Taifa's stated intent; ratified only on Kira's explicit confirm | `roles_v15.test.js` |
| 9 | **LI-4** — CEO pay visibility (v1.5) | R14 CEO/Executive: read-only dashboard+reports, org-wide, **NO individual pay/medical** | **OPEN**: default is aggregates-only. Do NOT add R14 to pay field rules / a3.pay.roles without Kira | `roles_v15.test.js` |
| 10 | **LI-3** — finance restructure (v1.5) | R08/R09 removed (rows migrated to R15); R15 Finance Manager + R16 CFC added; pay/bank = R07,R11,R15,R16; finance stays directory-denied | Confirm the merge, the pay set, the R08→R15/R09→R15 migration, and directory denial for R15/R16 | `roles_v15.test.js` |
| 11 | **LI-6** — payroll.run + ingest SoD (v1.5) | `payroll.run` = R15,R16 (**R12 admin removed**); ingest maker=R15 / checker=R16 | Confirm admin-may-not-run-payroll and the finance maker/checker split | `roles_v15.test.js`, `ingest.test.js` |

> **Design reconciliation (v1.5):** per `src/roles.js`'s standing caveat, the exact
> module-per-role rows are a derivation — the v1.5 changes (R03's absorbed clinic
> modules; the new R14, R15 and R16 rows; the R08/R09/R10 removals) must be
> reconciled against the approved design at UAT alongside the original matrix.

## B. Open client decisions (BLOCK related function until decided)

| Item | Owner | What is gated |
|---|---|---|
| **Carry policy** | Baraka | Opening-bucket rows stay lapse-EXEMPT; the bucket→normal-carry conversion is deliberately unbuilt |
| **Duplicate-file question** | Baraka | Treatment of cross-file duplicate PFs beyond flagging to the exception report |
| LR-6 coverage thresholds | client | `leave.coverage.thresholds` [TBC] — blocks |
| PC-2 partial period | client | `payroll.partial_period` [TBC] — blocks |
| Emp-no rollover >9999 | governance | Generator refuses to overflow |
| A3 refinements (R08 pay, R11 medical, R05 scope) | 4-July return | `pending.a3.*` [TBC] |
| HSEQ competency (SQ-3), asset owner, ES-1/ES-4, JML-3 | governance | Each [TBC] — blocks at use |
| `exact.reconciliation` (full-period EXACT-07) | first populated period | Full control-totals reconciliation gated (per-row net check runs now) |

## C. Standing caveats

- **Residency:** UAT runs on Hostinger-EU under the documented waiver
  (`UAT-RESIDENCY-WAIVER.md`); the registry stays `af-south-1`; **production must
  be in-region** — separate Kira decision.
- **Data:** UAT carries TEST data only until the carry policy lands.
