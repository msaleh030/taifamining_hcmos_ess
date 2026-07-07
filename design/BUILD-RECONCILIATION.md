# Build ↔ spec reconciliation (view layer, honest gaps)

Authority: the spec owns how it LOOKS; the registry + certified backend own
behaviour and gating. Where they diverge the BACKEND WINS and the doc gets
corrected. Nothing below changes a gate — drawing a view is not ratifying
who sees it.

## Doc corrections for Design (spec prose is stale vs certified v1.5)

| Spec says | Certified backend (wins) |
|---|---|
| Role lists name R08/R09/R10; no R14/R15/R16 (C5 pay → "R07, R09, R11"; C16 → R07/R08/R09/R11; C18 → R07/R08/R09/R12; medical → R05/R06/R10) | v1.5: R08/R09/R10 removed; pay/bank = R07,R11,R15,R16; medical = R03,R05,R06; payroll.run = R15,R16; controls = R11,R12 (R07 refused — matches) |
| E4: "Carry lapses after 1 year (LR-4)" | v1.5 carry rule: cap 10 days at employment anniversary, forfeit at +3 months, opening bucket exempt (leave.test.js) — build wording follows this |
| C1: "Lockout policy value is [TBC]" | Applied default 5 attempts / 900 s, pending ratification (RATIFY-AT-UAT #1) |

## Backend gaps the spec draws but no certified endpoint serves (STOPPED, per the boundary — needs Kira before any backend change)

1. **C2 Overview aggregates** — headcount/active/on-shift/on-leave/new-month/
   open-approvals tiles, workforce-by-site, employment-type, activity feed,
   pending-approvals panel. Built: navigable KPI strip from the certified
   scorecard + designed empty states. Needs: an overview-aggregates endpoint.
2. **C10 Leave approve + coverage** — ~~approval queue, coverage meter, audited
   override. The certified leave flow is apply/balance (self-service, server-
   validated); there is no request-queue/approve endpoint.~~ **BUILT on Kira's
   order (2026-07-06)**: `GET /leave/requests` (queue + per-request coverage
   meter) and `POST /leave/requests/:id/decide` — RBAC `leave.approve`
   (R02/R04/R11), SOD-01 same-user-403, site-bound approvers scoped to their
   site. LR-6 coverage is warn-not-block: `leave.coverage.thresholds` stays
   [TBC] (meter reads `pending`, approval proceeds); once set, a below-threshold
   approval 409s until the acknowledged override, which is audited (UNI-06).
   Apply now accepts an optional from/to window (coverage math; `days` stays
   authoritative for balances). Pins: `test/c10_leave_approve.test.js`.
   Screen build can proceed.
3. **C20b alert configuration** — per-doc-type lead-time set/repeat/clear.
   Built: sweep + routed-role list (certified); lead-time chips display the
   DA-1 registry values read-only.
4. **E6 Payslip** — ~~own-payslip endpoint for ESS (the publish leg pushes
   payslips; there is no GET /me/payslip yet). Screen not built rather than
   mocked.~~ **BUILT on Kira's order (2026-07-06)**: `GET /me/payslip` +
   `GET /me/payslips` (history) — own-only by construction (no employee
   parameter), visible only after publish + ESS leg posted (C18), wording
   pinned Total Pay / Net Pay = Total Pay − Total Deduction
   (`test/payslip.test.js`). a3.pay.roles untouched. Screen build can proceed.
5. **E2 extras** — documents list for self, notifications, smart-ID data.
   Home is composed from certified endpoints only.
6. **Directory site column** (C4 names site; the list payload carries dept,
   not site) and **leave from/to dates** (E4 draws dates; the endpoint takes
   day counts).

## Derived-token flags for Design (landed in hcmos.css Part 2, marked)

- Glass/Reduced `--border-2`, `--raise`, `--shadow-l` did not exist in the
  flow kits — derived conservatively; confirm values.
- DESIGN.md's WCAG-AA callout (green/blue/red/faint fail AA at body size)
  still needs Design's confirmation; the build never uses semantic colour as
  the only signal (labels/icons ride every status).

## Visual-parity mechanism

`design/baselines/` holds the Design-approved renders (captured from the
prototypes by `scripts/design-baselines.sh`). Once npm is reachable, CI runs
the Playwright pass: build the frontend, drive each screen to each enumerated
state, screenshot at the spec surfaces, and diff against accepted baselines —
the executable half of the parity bar.
