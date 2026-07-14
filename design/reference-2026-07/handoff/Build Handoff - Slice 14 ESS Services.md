# Build Handoff — Slice 14: ESS services (E2 · E5 · E10 · E11 · E13 · E14)
For Claude Code. Build to the approved design `HCMOS ESS Services.html` (Home, My Documents, Notifications, digital ID card, profile gate, suspended/blocked); do not redesign. Carries **AC-UNI-01 (offline/sync), UNI-06, DOC, PRT-01/02, AUTH-04/06, LVR-01, DISC-03** and **A3** confidentiality. Source of truth: Criteria Register **v1.2** + A2/A3. Brings the last ESS rows to the full standard (8 states · 4 themes · 4 surfaces · EN+SW). Field app is R13-first, mirrored to R01–R12 via C23.

> Execution note: three rules govern the ESS surface. **(1) Confidentiality is absence** — a document or field the employee may not see is **not shown** (A3), and the ID card renders **only permitted fields** (PRT-01). **(2) Everything syncs** — Home, Documents and Notifications are readable offline from the last synced copy; new reads/changes reconcile on reconnect (UNI-01), audited (UNI-06). **(3) Access follows status** — an incomplete profile gates ESS until required fields are in (E13); a suspended (DISC-03) or terminated (LVR-01/AUTH-04) account blocks ESS, with suspended and closed drawn distinctly.

## Data / reuse — no new core tables
Reuse `employee`, `employee_document` (S2, A3 scoping), `notification` (S4/S9, bilingual body), `attendance_punch` (S5, clock chip), `employee.status` (S3, gate/block), `audit_log` (S1). ID card renders from `employee` permitted fields + a signed verification token behind the QR (offline-verifiable).

## Screens → ACs
| Screen | Implements | Rule |
|--|--|--|
| **E2 Home** | AUTH-06, UNI-01 | Role landing (A2): greeting, clock chip (from S5), quick actions, activity feed, outstanding items. Offline → last synced copy. |
| **E5 Documents** | DOC, PRT-02, A3 | My Documents (payslips/contract/certs/ID). Confidential items (e.g. a disciplinary letter the employee may not open) are **restricted-not-shown**. Offline downloads queue. |
| **E10 Notifications** | UNI-01 | Unread tracking + mark-read; **bidirectional ESS↔HCMOS sync**; offline shows last synced, reconciles on reconnect. |
| **E11 ID card** | PRT-01, A3 | Digital card renders **only permitted fields**; confidential fields never appear; QR carries a signed token for **offline verification**; ID no. `TMCL-<LOC>-<SEQ>`. |
| **E13 Profile gate** | UNI-01 | Required-field checklist + progress; **blocks self-service** (leave/payslip/clock-in) until complete; completing unlocks. |
| **E14 Suspended / blocked** | AUTH-04, DISC-03, LVR-01 | Suspended (disciplinary, reversible) and terminated/closed (separation) drawn as **distinct** blocks; ESS paused; final documents remain with HR. |

## States (from the state switcher)
`empty` · `loading` · `populated` · `large-data` (full activity history, all payslip periods, all notifications — virtualised) · `error` · `no-permission` (item outside the employee's access → not-available; on Blocked = terminated variant) · `offline` (last synced copy; actions queued) · `success`. Confidential-absence, gate-unlock, and suspended-vs-terminated are drawn explicitly.

## Section 17 tests
1. **Confidential absence (A3):** a document/field outside the employee's rights is **not returned**; the ID card payload contains only permitted fields.
2. **Offline sync (UNI-01):** Home/Docs/Notifications read from cache offline; changes reconcile once on reconnect; notification read-state syncs both ways.
3. **Profile gate (UNI-01):** with a required field missing, gated actions are blocked; completing the field unlocks; enforced server-side, not just UI.
4. **Status block (AUTH-04/DISC-03/LVR-01):** suspended and terminated accounts are blocked from ESS; suspended is reversible on lift, terminated is not; both distinct from active.
5. **ID verification (PRT-01):** the QR token verifies offline and resolves to the correct employee/number without exposing confidential fields.

## Definition of done
UNI-01/06, DOC, PRT-01, A3, AUTH-04/06, DISC-03, LVR-01 behaviours pass; confidentiality proven as absence; offline sync and gate/block enforced server-side. Then flip **E2, E5, E10, E11, E13 and E14 rows to green** (done in design) — completing the ESS inventory.
