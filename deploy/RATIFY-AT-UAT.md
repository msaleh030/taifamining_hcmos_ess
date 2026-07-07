# Ratify-at-UAT agenda (consolidated)

Every **Applied, pending ratification** value in one place for the UAT session.
Each is a REAL value that applies now (not [TBC]-gated), is pinned by a test, and
flips via a **registry edit, not a deploy**. Do not change any of these without
Kira; a drifted value fails CI.

**v1.6 (Kira, RATIFIED — client decisions, listed for the record, not for debate):**
R05 HSE Officer absorbed by R06 (renamed **SHEQ Manager**, Maurice) — landing,
field rules, issuer/alerts/notify sets updated, live rows migrated (018);
R11 renamed **Head of HR** (Omid); finance SoD assignment: **Cecilia Mtweve =
R15 maker**, **Omid = R16 checker** (two people — never vest both in one).
Still to CONFIRM at UAT: the `contract` DA-2 reroute R05→R06 (Code's inference,
row 2) and the dual-role `+alias` email convention (GO.md step 4).

## A. Applied values to ratify

| # | Registry key | Applied value | Question for the client | Pinned by |
|---|---|---|---|---|
| 1 | `auth.lockout.threshold` / `.duration` | 5 attempts / 900 s | Confirm the lockout policy | `auth.test.js` |
| 2 | `doc.notify.role.*` (DA-2) | **RATIFIED IN FULL (Kira, 2026-07-06)**: expat/immigration permit→**R11 ONLY** (sensitive — visibility + notification, never R06); business permit + licence→**R06**; medical→**R03 site-matched to the employee** (not all HR Officers); **contract splits expat-vs-local** (supersedes the R06 inference): expat contract→**R11 ONLY**, local contract→**site-matched R03**. Expat-vs-local is the employee-level `is_expat` flag driven by the authoritative 61-name classification CSV (`scripts/classify-expats.js` — matches only, unmatched rows reported, never guessed). Unclassified permits fail closed to R11, flagged | `slice9.test.js` (routing + visibility), `slice10.test.js`, `f7.test.js`, `classify_expats.test.js` |
| 3 | `policy.publish.roles` | R12 | Publish owner: IT-admin (R12) vs HR (R07)? Org RACI may differ | `f7.test.js` |
| 4 | `support.agent.roles` | R12 | R12-only vs an HR / dedicated support owner? | `f7.test.js` |
| 5 | `alerts.view.roles` | R03,R04,R06,R11,R12 (v1.5: R10 dropped; v1.6: R05 dropped) | Deliberately NOT reports-scoped (R03, a DA-2 recipient, has no reports module) — ratify as-is | `f7.test.js` |
| 6 | `controls.view.roles` | R11,R12 | Confirm AUD/SOD membership (RACI may add/replace) | `f7_controls.test.js` |
| 7 | `ingest.roles` / `ingest.maker.roles` / `ingest.checker.roles` | union R15,R16; maker=R15 (Finance Manager), checker=R16 (CFC) | v1.5 LI-6: role-split SoD (disjoint maker/checker roles + same-user-403). Confirm the finance ownership (was R11/R12) | `ingest.test.js`, `load_ingest.test.js` |
| 8 | **LI-5** — HR-medical widening (v1.5) | `a3.medical.roles` = R03,R06 (v1.6: R05 absorbed by R06); `FIELD_RULES` medical/permits +R03 | **RATIFIED (Kira, 2026-07-06)**: only HR Officers do clinic/medical admin — confirmed, not pending. R03-sees-medical pin stays | `roles_v15.test.js` |
| 9 | **LI-4** — CEO pay visibility (v1.5) | R14 CEO/Executive: read-only dashboard+reports, org-wide, **NO individual pay/medical** | **OPEN**: default is aggregates-only. Do NOT add R14 to pay field rules / a3.pay.roles without Kira | `roles_v15.test.js` |
| 10 | **LI-3** — finance restructure (v1.5) | R08/R09 removed (rows migrated to R15); R15 Finance Manager + R16 CFC added; pay/bank = R07,R11,R15,R16; finance stays directory-denied | Confirm the merge, the pay set, the R08→R15/R09→R15 migration; and whether FM/CFC need DIRECTORY lookup (denied today, inherited from R08/R09 — Code's inference, held for UAT) | `roles_v15.test.js` |
| 11 | **LI-6** — payroll.run + ingest SoD (v1.5) | `payroll.run` = R15,R16 (**R12 admin removed**); ingest maker=R15 / checker=R16 | Confirm admin-may-not-run-payroll and the finance maker/checker split | `roles_v15.test.js`, `ingest.test.js` |
| 12 | **LR-8/LR-9** — carry policy values (v1.5) | cap **10 days** at the employment anniversary; forfeit unused at anniversary + **3 months**; opening bucket exempt | Confirm the 10-day cap and 3-month window (the flat one-year lapse is REPLACED). **Interpretation RATIFIED (Kira, 2026-07-06)**: the two judgment calls — carried days consumed FIRST when leave is taken, and forfeiture takes the OLDEST carry first (FIFO) — are confirmed as built; pins stay | `leave.test.js` |

> **Design reconciliation (v1.5):** per `src/roles.js`'s standing caveat, the exact
> module-per-role rows are a derivation — the v1.5 changes (R03's absorbed clinic
> modules; the new R14, R15 and R16 rows; the R08/R09/R10 removals) must be
> reconciled against the approved design at UAT alongside the original matrix.

## B. Open client decisions (BLOCK related function until decided)

| Item | Owner | What is gated |
|---|---|---|
| **Carry policy (opening bucket)** | Baraka | The GOING-FORWARD rule is BUILT (v1.5 LR-4/8/9); opening-bucket rows stay EXEMPT and the bucket→normal-carry conversion stays deliberately unbuilt until Baraka decides |
| **Duplicate-file question** | Baraka | Treatment of cross-file duplicate PFs beyond flagging to the exception report |
| LR-6 coverage thresholds | client | **Floor DECIDED (Kira, 2026-07-07)**: `leave.coverage.thresholds` = `default:1` — warn the approver only when an approval would leave a role at a site with ZERO present (at least one must remain). Warn-not-block; per-role values from Omid/Baraka layer on via registry edit (`default:1,R13:5`), no deploy. Pinned `c10_leave_approve.test.js` |
| PC-2 partial period | client | `payroll.partial_period` [TBC] — blocks |
| Emp-no rollover >9999 | governance | Generator refuses to overflow |
| A3 refinements (R11 medical, R05 scope) | 4-July return | `pending.a3.*` [TBC] (r08_pay removed — superseded by v1.5 LI-3 finance pay visibility) |
| HSEQ competency (SQ-3), asset owner, ES-1/ES-4, JML-3 | governance | Each [TBC] — blocks at use |
| `exact.reconciliation` (full-period EXACT-07) | first populated period | Full control-totals reconciliation gated (per-row net check runs now) |
| Exact round-up/round-down column positions | appendix | `exact.col.roundup` / `exact.col.rounddown` [TBC] — contribute 0 to the net identity until set; the identity + North Mara footing are pinned by fixture (`exact.test.js`) |

## C. Standing caveats

- **Residency:** UAT runs on Hostinger-EU under the documented waiver
  (`UAT-RESIDENCY-WAIVER.md`); the registry stays `af-south-1`; **production must
  be in-region** — separate Kira decision.
- **Data:** UAT carries TEST data only until the carry policy lands.
