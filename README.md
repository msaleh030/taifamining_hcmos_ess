# HCMOS ESS — Slice 1: Authentication & Access

Backend contract for **Slice 1** of the HCMOS Employee Self-Service system,
built to the handoff for Acceptance Pack `RTL/ACP/TM/001/2026` (+ Addenda A1
roles, A2 landing, A3 confidential fields).

This repository implements the **Postgres + RLS + API** side that the handoff
identifies as the home of the green automated tests. The design HTML files are
the UI truth and are not reproduced here; where a UI artifact was needed but not
delivered (the A2 role→module table), the derivation is documented below and
isolated to one file so it can be reconciled without touching the mechanism.

## Quick start

```bash
npm run setup     # start Postgres, create db + roles, configure local trust auth
npm run migrate   # apply db/schema.sql (tables, RLS, audit chain, auth functions)
npm run seed      # load deterministic fixtures
npm test          # AC-AUTH-01..06 + Section 17 + lockout/hash-chain  (pretest re-runs the above)
```

`npm test` is self-contained: its `pretest` runs setup → migrate → seed. A
`SessionStart` hook (`scripts/session-start.sh`) does the same so a fresh
Claude Code (web) session is testable immediately.

> No external npm/pip packages are used — the environment has no package
> registry access. The Postgres client (`src/pg.js`) is a small pure-Node
> implementation of the wire protocol (extended query = server-side parameter
> binding, so there is no SQL-injection surface). Everything else is Node stdlib.

## Security model

| Concern | How it is enforced |
|--|--|
| **Tenant isolation (AC-UNI-04/05)** | RLS is **enabled on every table**; policy `company_id = current_company()`. The app connects as the **non-superuser** role `hcmos_app`, so RLS genuinely constrains it. `app.company_id` is set (via `SET LOCAL`) **from the verified session** on every authenticated request. UI hiding is never the control. |
| **Auth bootstrap** | Resolving a login before a session exists, validating a session token, and writing the audit chain are the only legitimate cross-tenant operations. They live in `SECURITY DEFINER` functions owned by `hcmos_owner` (the table owner, which bypasses RLS because RLS is not `FORCE`d). They are the authentication boundary, not a data bypass — no data-serving endpoint bypasses RLS. |
| **No direct writes** | `hcmos_app` has only `SELECT` on tables (RLS-scoped) + `EXECUTE` on the auth functions. Every mutation flows through an audited `SECURITY DEFINER` function. |
| **Append-only audit** | `audit` is chained per tenant: `hash = sha256(prev_hash ‖ payload)`. `UPDATE`/`DELETE` are blocked by a trigger. Sign-in, reset and lockout events are recorded. |
| **Generic auth errors (AUTH-04)** | Any console/field failure returns `401 {"error":"authentication failed"}` — the failing factor is never named. |
| **Secrets** | Passwords and PINs are scrypt-hashed (`src/crypto.js`); MFA is RFC-6238 TOTP. PINs are bound to the **device**, never to an email. |

## Endpoints → Acceptance Criteria

| Endpoint | AC | Notes |
|--|--|--|
| `POST /auth/console` `{email,password,mfa}` | AUTH-01/03/04/06 | verifies all three factors; refuses `terminated`/`suspended` and locked accounts; creates a `company_id`+`role_code`-scoped session; returns the A2 landing route; generic error on any failure |
| `POST /auth/field` `{device_id,pin,idempotency_key?}` | AUTH-02/03/04 | registered+active device only (unregistered refused server-side); refuses if the device's employee is terminated; offline replays dedupe on the idempotency key |
| `POST /auth/reset/password` | AUTH-05 | permitted owner role only (`password.reset.owner` from `config`); rotates the credential; **revokes all of that user's sessions** |
| `POST /auth/reset/pin` | AUTH-05 | permitted owner only (`pin.reset.owner`); rotates `device.pin_hash`; revokes related sessions |
| `GET /me/landing` | AUTH-06 | returns only the modules permitted for `role_code` (A2); least privilege |
| `GET /me/profile/:employeeId` | A3 | confidential fields enforced server-side; forbidden fields are **absent**, not masked |
| `POST /action/:name` | Section 17.4 | server-side RBAC matrix; `admin.*` are R12-only |

## Section 17 tests (all green)

1. **Tenant isolation** — authenticated as tenant A, neither the API nor a
   crafted direct query returns a tenant-B row (not-found, not the row).
2. **Terminated block** — a terminated user with valid console creds *and* a
   valid device PIN is refused on **both** channels.
3. **Session invalidation** — after a password reset, the prior token is dead
   (401) and returns no protected data.
4. **RBAC server-side** — `R01` calling an `R12`-only action is refused even
   though the UI never offered it; `R12` is allowed.
5. **AC-AUTH-03 lockout** — repeated failures lock per the `config` policy and
   the lock event is audited; the audit hash chain is verified intact.

## Configuration ([TBC] — read from `config`, never hard-coded)

Per-tenant rows in the `config` table (seeded with defensible defaults in
`src/config.js`), pending the 4 July governance return:

- `auth.lockout.threshold`, `auth.lockout.duration`
- `password.reset.owner`, `pin.reset.owner`, `device.reenrolment.owner`
- `session.ttl`, `session.field.ttl`, `field.default.role`

## Open assumptions to confirm before launch

- **A2 landing map** (`src/roles.js` `LANDING`): the authoritative R01..R13
  module set lives in `HCMOS Auth Flow.html`, which was **not delivered into
  this repo**. The map here is a documented least-privilege derivation; the
  *mechanism* (server-side, least-privilege, no forbidden links) is final and
  tested — only the specific module-per-role rows are provisional.
- **A3 field rules** are taken verbatim from the Acceptance Pack and are final:
  pay/bank → R07,R09,R11; medical/permits → R05,R06,R10; disciplinary →
  R05,R06,R07,R11; everything else omitted.
- **`pin.reset.owner` / `device.reenrolment.owner`** owners are `[TBC]` in the
  pack; defaults are seeded and read from `config`.

## Layout

```
db/schema.sql        tables, RLS policies, audit hash chain, SECURITY DEFINER auth fns
src/pg.js            pure-Node Postgres wire client + pool
src/db.js            withTenant / query / withOwner helpers
src/crypto.js        scrypt hashing, TOTP, session tokens
src/roles.js         A2 landing map, A3 field rules, RBAC action matrix
src/config.js        per-tenant config defaults + readers
src/auth.js          auth service (one function per AC)
src/server.js        HTTP API (Node http only)
scripts/             setup-db / migrate / seed / session-start
test/                fixtures, helpers, auth.test.js, section17.test.js
```
