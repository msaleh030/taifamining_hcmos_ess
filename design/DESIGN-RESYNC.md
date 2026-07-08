# Design-to-live re-sync (Kira, 2026-07-07)

**Goal:** every LIVE screen must match Design's CURRENT work exactly. The
accepted baselines (`design/app-baselines/`, 36 PNGs) are stale vs Design's
current screens — confirmed at least for console login. This doc tracks the
divergence list, the rebuild, re-acceptance, and redeploy.

**View layer ONLY.** No change to auth behaviour, gating, confidentiality, or
any backend logic. Preserved invariants:
- Console login = email + password + MFA **only** — never a PIN.
- PIN is ESS-only (field login, device + PIN).
- The console/ESS auth split stays intact regardless of visual changes.

**Decisions resolved (Kira, 2026-07-07):**
- Reference delivery = **updated prototype/spec HTML** (Design republishes the
  prototype HTMLs + `HCMOS-Design-Spec.html` at their current state; I render
  and pixel-diff per screen — the same method that made the original baselines).
- Login **SSO = OUT** — login stays email + password + MFA only, no SSO
  affordance. The factor set is therefore unchanged from the live build; any
  remaining login divergence is other visual detail, resolved against the
  reference. The login rebuild is UN-gated once the reference lands.

**STILL BLOCKED on:** the reference files themselves. The prototypes/spec on
disk are the **Jul-5 originals** the current build already matches — diffing
against them shows zero divergence, which contradicts the confirmed login
divergence, so Design's CURRENT set is newer and NOT yet delivered. No diff or
rebuild can be truthfully done until it arrives (must not fabricate against
stale references).

---

## Divergence list (to be filled against Design's CURRENT reference)

18 screen-states × 2 themes = the 36-baseline set. `build == current Design?`
gets marked per row once the reference lands. AC = the acceptance-criteria id
the state renders.

| # | Screen-state (baseline stem) | AC | Surface | Component | Diverges? | Notes |
|---|------------------------------|----|---------|-----------|-----------|-------|
| 1 | c1-login-empty | C1 | desktop+mobile | Login.tsx | **YES (confirmed)** | console login changed in Design's current work; SSO in/out pending |
| 2 | c1-login-error | C1 | desktop+mobile | Login.tsx | **YES (confirmed)** | same screen, error state |
| 3 | c2-overview | C2 | desktop | Overview.tsx | ? | |
| 4 | c3-scorecard | C3 | desktop | Kpi.tsx | ? | |
| 5 | c4-directory | C4 | desktop | Directory.tsx | ? | |
| 6 | c5-profile-drawer | C5 | desktop | Directory.tsx (drawer) | ? | |
| 7 | c16-liability-empty | C16 | desktop | Liability.tsx | ? | |
| 8 | c16-liability-r03 | C16 | desktop | Liability.tsx | ? | |
| 9 | c20-controls | C20 | desktop | Controls.tsx | ? | |
| 10 | c20b-alerts | C20b | desktop | Alerts.tsx | ? | |
| 11 | c21-tenant-noperm-or-step1 | C21 | desktop | Tenant.tsx | ? | |
| 12 | e7-policy | E7 | desktop | Policy.tsx | ? | |
| 13 | e12-support | E12 | desktop | Support.tsx | ? | |
| 14 | e2-ess-home | E2 | mobile | EssHome.tsx | ? | |
| 15 | e4-apply-leave | E4 | mobile | Leave.tsx | ? | |
| 16 | e8-my-kpis | E8 | mobile | Kpi.tsx (mine) | ? | |

Screens with components but no current baseline row (confirm with Design whether
a reference exists for these — they may be additional divergences to add):
Attendance.tsx (F5 clock-in), Disciplinary.tsx (C8), Exact.tsx (F6).

---

## Console login — as-built (the confirmed divergence anchor)

Live render today (`frontend/src/screens/Login.tsx`), for Design to diff against
their current login reference:
- Two-panel split canvas `.login` (grid 1.05fr / 1fr). Left: dark brand panel
  `.login-brand` — `HCMOS™` mark, Tanzania tricolor flag (green #1FA24A / amber
  #FBC02D / blue #0094D4), eyebrow "TAIFA MINING & CIVIL", h1 "Human capital,
  operational", subhead, footer help line.
- Right: centred form `.lf-inner` (max 380) — title/subtitle, then THREE fields:
  **Email** (IcUser), **Password** (IcLock), **MFA** (IcShieldDots, optional
  input, server-enforced when `auth.mfa.required`). Primary submit, help line.
- Error state: ONE generic banner (`.banner.err`) — never names the failed
  factor (AUTH-04).
- **No PIN field, no SSO link today.** SSO is the pending Design/Kira decision.

Any visual rebuild keeps the three-factor console form and never adds a PIN.

---

## Pipeline readiness (verified 2026-07-07)

The regen → accept → enforce → redeploy loop is intact and ready:
- Visual harness: `frontend/visual/screens.spec.ts`, config
  `snapshotPathTemplate: '../design/app-baselines/{arg}{ext}'`,
  `maxDiffPixelRatio: 0.001` (pixel-true; self-hosted IBM Plex).
- CI (`.github/workflows/ci.yml`, job `designed-frontend`): candidate/enforce
  switch — while `design/app-baselines/` is EMPTY it GENERATES candidates
  (uploaded as an artifact for Design); once PNGs exist it ENFORCES at 0.001.
- Redeploy: the Frankfurt box takes the enforced build via the deploy sentinel
  (idempotent; seed-guard preserves users/data).

**Sequence once the reference + SSO decision land:**
1. Fill the divergence list (build vs Design's current reference).
2. Rebuild each divergent screen — view layer only.
3. Clear `design/app-baselines/` → CI regenerates the FULL candidate set (all
   screens, both themes, both surfaces) → artifact to Design via Kira.
4. On Design's acceptance, commit the 36 candidates to `design/app-baselines/`
   → CI re-enforces (green).
5. Redeploy the enforced build to Frankfurt; LIVE = current Design.
