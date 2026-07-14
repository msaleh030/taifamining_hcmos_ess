# Build Handoff — Slice 1: Authentication & Access
For Claude Code. Build to the approved design `HCMOS Auth Flow.html`; do not redesign. Source of truth: Acceptance Pack RTL/ACP/TM/001/2026 (+ Addenda A1 roles, A2 landing, A3 confidential fields).

> Execution note: running these as green automated tests happens in the Claude Code repo (Postgres + RLS + API). This file is the contract; the design files are the UI truth.

## Data model (minimum)
- `tenant(company_id PK, name, status)`
- `app_user(id PK, company_id FK, employee_id FK, email, password_hash, mfa_secret, role_code CHECK in R01..R13, status CHECK in active|suspended|terminated, created_at)`
- `device(id PK, company_id FK, employee_id FK, enrolled_at, pin_hash, status)` — PIN bound to device, never to email
- `session(id PK, company_id FK, user_id FK, role_code, created_at, expires_at, revoked_at)`
- `audit(seq PK, company_id, actor, role, action, entity, entity_id, ts, before, after, prev_hash, hash)` — append-only
- `config(company_id, key, value)` — lockout + enrolment owners live here, NOT in code

## RLS (AC-UNI-04/05) — every table
- Enable RLS; policy: `company_id = current_setting('app.company_id')::uuid`. Set `app.company_id` from the verified session on every request. No query bypasses it. UI hiding is never the control.

## Endpoints → ACs
| Endpoint | Implements | Rule |
|--|--|--|
| `POST /auth/console` (email,password,mfa) | AUTH-01/03/04/06 | verify all three; on success create `session` scoped to `company_id`+`role_code`; respond with A2 landing route; **generic** error on any failure (never name the factor); refuse if `app_user.status='terminated'`; audit sign-in |
| `POST /auth/field` (device_id, pin) | AUTH-02/03/04 | verify `device.status='active'` AND `pin_hash` match AND device belongs to tenant; **refuse unregistered device server-side**; offline: client queues with idempotency key, server validates + dedupes on sync; terminated refused; audit |
| `POST /auth/reset/password` | AUTH-05 | permitted owner only; rotate credential; **delete/revoke all `session` rows for that user**; audit reset |
| `POST /auth/reset/pin` | AUTH-05 | permitted **device-enrolment/PIN owner [TBC]**; rotate `device.pin_hash`; revoke that user's sessions; audit |
| `GET /me/landing` | AUTH-06 | return only modules permitted for `role_code` per A2; least privilege; no link to forbidden area |

## Role landing (A2) + confidential fields (A3)
- Landing/module set per role exactly as encoded in `HCMOS Auth Flow.html` ROLES table (R01..R13).
- A3 field visibility enforced server-side on profile reads: pay/bank → R07,R09,R11; medical/permits → R05,R06,R10; disciplinary → R05,R06,R07,R11; all others: field omitted from the response (absent, not masked).

## Section 17 tests — must be green before launch
1. **Tenant isolation:** authenticate as tenant A; assert no endpoint, by any route or crafted query, returns a row where `company_id != A` (returns not-found, not the row).
2. **Terminated block:** seed a terminated user with valid email+password+MFA and a valid device PIN; assert `POST /auth/console` AND `POST /auth/field` both refuse.
3. **Session invalidation:** create a session; call password reset; assert the prior session token is dead (401) and no protected data returns.
4. **RBAC server-side:** as R01, call an R12-only action with a crafted direct request; assert server refusal (matrix checked server-side even though UI never offered it).
- Plus AC-AUTH-03: assert repeated failures lock per `config` lockout policy and the lock event is audited.

## [TBC] — read from `config`, never hard-code (4 July governance return)
- `auth.lockout.threshold`, `auth.lockout.duration`
- `device.reenrolment.owner` (new phone / replaced kiosk), `pin.reset.owner`

## Definition of done
AC-AUTH-01..06 pass as automated tests; the four Section 17 tests pass; the audit shows sign-in / reset / lockout entries on an intact hash chain. Then flip the Authentication production rows to green on the readiness checklist.
