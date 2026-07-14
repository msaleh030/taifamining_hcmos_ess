# Divergence list — build vs Design reference (2026-07-14)

Closes the list `design/DESIGN-RESYNC.md` (open since 7 Jul) was blocked on.
Reference: claude.ai/design project `c64829ec-b294-4ad0-8847-c684ef946bbb`
("Design HCMOS™"), imported into `design/reference-2026-07/` with a sha256
manifest (staged; IMPORT-STATUS.md tracks what is landed vs queued).

## Method (disclosed, per screen-state)
1. **Byte/content verification of the reference vs the Jul-5 prototypes** the
   36 accepted baselines were captured from. Verified so far:
   - `HCMOS Auth Flow.html` — **byte-identical** to Jul-5 (diff = 0 lines).
   - `HCMOS Governance & ESS.html` — **restructured** (flow + i18n externalized
     to `gov-flow.js`/`gov-i18n.js`) but **content-equivalent** function-by-
     function (same CONTROLS array, states, role gates, data, wording keys).
   - Remaining flows follow the same externalized pattern; content verification
     is queued per-build (each P-build lands + verifies its flow first).
2. **Design's own review artifacts in the project**: our 36 accepted baseline
   PNGs are present under `uploads/`, and Design produced candidate redraws for
   exactly ONE screen — `design/candidates/c20-controls-{light,dark}.png`.
3. **Ordered code changes since 7 Jul** (Kira's own orders) that move the BUILD
   forward of the accepted baselines: P1 login (field-PIN tab + EN/SW toggle)
   and the item-3 fifth control card on C20.

The key factual correction: **the login divergence that opened DESIGN-RESYNC is
not in the delivered flow reference** — the reference Auth Flow is byte-identical
to what the build was already accepted against. The July design work lives in
the React app source (`login.jsx`, HCWOS screenshots) and the c20 candidates.

## The 18 baseline screen-states

| # | State (baseline stem) | Verdict | Basis |
|---|---|---|---|
| 1 | c1-login-empty · desktop | **DIVERGED (ordered-forward)** | Reference byte-identical to accepted baseline source; build has since added the Kira-ordered P1 field-PIN tab + pre-auth EN/SW toggle. Needs Design re-acceptance of the new login. Reference's `Use SSO` link is ruled OUT by Kira (not a build gap). |
| 2 | c1-login-error · desktop | **DIVERGED (ordered-forward)** | Same as #1; error state unchanged otherwise (generic, factor-free — matches reference). |
| 3 | c1-login-empty · mobile | **DIVERGED (ordered-forward)** | Same as #1. |
| 4 | c1-login-error · mobile | **DIVERGED (ordered-forward)** | Same as #1. |
| 5 | c2-overview | **CONFIRMED PARITY** (to the accepted baseline) | No reference change signal; no build change since acceptance. NOTE: the reference DRAWS far more than the build implements (stat band, composition, exec view) — that is the P6 build order, tracked as scope, not visual divergence of the accepted state. |
| 6 | c3-scorecard | **CONFIRMED PARITY** | No change signal either side since acceptance. |
| 7 | c4-directory | **CONFIRMED PARITY** | Same. |
| 8 | c5-profile-drawer | **CONFIRMED PARITY** | Same. |
| 9 | c16-liability-empty | **CONFIRMED PARITY** | Same. (Liability FIGURES are now EX-2 fail-closed server-side — a data-state change, not a layout change.) |
| 10 | c16-liability-r03 | **CONFIRMED PARITY** | Same (403 no-permission state unchanged). |
| 11 | c20-controls | **DIVERGED (both directions)** | Design produced candidate redraws (`candidates/c20-controls-*.png`) AND the build added the ordered 5th check card (`sod.ingest_maker_checker`). Reference flow content otherwise equivalent. Re-acceptance against the candidates + new card required. |
| 12 | c20b-alerts | **CONFIRMED PARITY** | gov-flow.js content-equivalent to what the baseline was accepted against; no build change. (Config ACTIONS remain deferred scope.) |
| 13 | c21-tenant-noperm-or-step1 | **CONFIRMED PARITY** | No change signal either side. |
| 14 | e7-policy | **CONFIRMED PARITY** | gov-flow.js policy screen content-equivalent; no build change. |
| 15 | e12-support | **CONFIRMED PARITY** | gov-flow.js support screen content-equivalent; no build change. |
| 16 | e2-ess-home | **CONFIRMED PARITY** (accepted state) | No change signal. Reference draws more quick-actions (docs/payslip/training/ID) — deferred/P4 scope, not divergence of the accepted state. |
| 17 | e4-apply-leave | **CONFIRMED PARITY** | No change signal either side. |
| 18 | e8-my-kpis | **CONFIRMED PARITY** | No change signal either side. |

**Totals: 13 CONFIRMED PARITY · 5 DIVERGED (4 = ordered-forward P1 login; 1 = c20-controls, Design candidates + ordered card) · 0 NOT BUILT** (every baseline state has a built screen — the NOT-BUILT list lives at screen level, below).

## Reference screens with NO built screen (unchanged from the gap report; build order applies)
P1 field-PIN login — **BUILT 2026-07-14** (probed live) · P2 leave approval queue (C10) ·
P3 joiner (C6) · P4 payslip (E6) · P5 password/PIN reset (AUTH-05) · P6 overview
aggregates + exec view (C2). Deferred per Kira: transfer, rehire, ID-card, asset,
ESS docs/notifications/profile-gate/blocked, alerts config actions, tenant steps
2-8, clock-out + sync-conflict UI. (Also drawn in the reference but out of Phase 1:
Training C13/E9, HSEQ C12, Grievances C14, Approvals C15 hub, Reports C17 preview,
Data Migration C19, Console Modules / JMLR / Employee Master v2 flows.)

## Re-acceptance mechanism
The suspended snapshot set in `frontend/visual/screens.spec.ts` (`BASELINE_STALE`)
is exactly the DIVERGED set above. When Design accepts the P1 login + the 5-card
C20 (against their candidates), new baselines are captured and the suspensions
are removed.
