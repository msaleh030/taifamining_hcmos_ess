# Reference import status (claude.ai/design project c64829ec-b294-4ad0-8847-c684ef946bbb, "Design HCMOS™")
Import runs in the PARENT session (DesignSync is not delegable). Staged by priority;
each file: fetched → written verbatim → sha256 recorded in MANIFEST.sha256.
Status: PENDING → IMPORTED (or SKIPPED-<reason>).

## Stage A (report-decisive)
- [x] HCMOS Readiness Checklist.md IMPORTED
- [x] Build Handoff - Slice 1 Authentication.md IMPORTED
- [x] i18n.jsx IMPORTED
- [ ] leave-i18n.js
- [ ] styles.css
## Stage B (divergence: the 8 flows covering the 18 baseline states)
- [x] HCMOS Auth Flow.html IMPORTED + VERIFIED BYTE-IDENTICAL to design/prototypes (Jul-5)
- [ ] HCMOS Workforce Overview.html
- [ ] HCMOS KPI Scorecard.html
- [ ] HCMOS Employee Master & Lifecycle.html
- [ ] HCMOS Leave & Liability Flow.html
- [x] HCMOS Governance & ESS.html IMPORTED (shell) + gov-flow.js VERIFIED CONTENT-EQUIVALENT to Jul-5
- [ ] HCMOS Tenant Provisioning.html
- [ ] HCMOS ESS Services.html
## Stage C (rest of reference — fetch per-build; full list in project inventory)

## Stage C imports 2026-07-14 (ESS slice — fetched for ESS-1..6 builds)
- [x] Build Handoff - Slice 14 ESS Services.md IMPORTED (handoff/)
- [x] ess-i18n.js IMPORTED (src/) — E2/E5/E10/E11/E13/E14 EN+SW strings
- [x] ess-flow.js IMPORTED (src/) — screen structure incl. blockedScreen (E14) + 8 home quick-actions
- [x] att-i18n.js IMPORTED (src/) — clock in/out, geofence, offline sync + CONFLICT strings EN+SW
- [x] att-flow.js IMPORTED (src/) — clock-out states + sync-queue/conflict card (keep-device/keep-server/keep-both)
