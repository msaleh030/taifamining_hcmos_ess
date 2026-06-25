# HCMOS ESS — Tenant-isolated HR platform (mining sector)

Backend for the HCMOS Employee Self-Service system, built to Acceptance Pack
`RTL/ACP/TM/001/2026` (+ Addenda A1 roles, A2 landing, A3 confidential fields).
Designed to start at ~2,000 users and grow to 10,000+, multi-tenant with
PostgreSQL Row Level Security as the hard isolation boundary.

- **Slice 1 — Authentication & Access** (C-AUTH): console + field sign-in, MFA,
  device PINs, lockout, credential resets, append-only audit, RBAC, A2 landing.
- **Slice 2 — Employee Master** (C4 directory + C5 profile): tenant + site-scoped
  directory at scale, A3 confidential-field absence, maker-checker edits with
  separation of duties, documents/assets.

## Quick start

```bash
npm run setup     # start Postgres; create db + non-superuser app role; trust auth; extensions
npm run migrate   # apply pending db/migrations/*.sql (versioned, additive, idempotent)
npm run seed      # load fixtures + 5,200-employee directory for the large-data test
npm test          # full suite (pretest re-runs setup → migrate → seed)
npm start         # run the HTTP API (PORT, default 3000)
```

A `SessionStart` hook (`scripts/session-start.sh`) runs setup → migrate → seed so
a fresh Claude Code (web) session is testable immediately.

> No external npm/pip packages are used — this environment has no registry
> access. The Postgres client (`src/pg.js`) is a small pure-Node implementation
> of the wire protocol with **server-side parameter binding** (no SQL-injection
> surface). Everything else is Node stdlib. See *Production readiness* for the
> driver swap before go-live.

## Architecture decisions (made for production at 10k users)

1. **Migrations are versioned, additive and non-destructive.** `db/migrations/NNN_*.sql`
   are applied once (tracked in `schema_migrations` with a checksum), each in its
   own transaction. There is **no `DROP TABLE` on deploy** — a destructive
   `schema.sql` would be unacceptable for a live tenant. To change schema, add the
   next migration; never edit an applied one.
2. **Confidential data is physically separated.** `employee_pay` / `employee_medical`
   / `disciplinary` are their own tables. A role that may not see pay does not have
   the join performed, so the key **cannot** appear in the JSON — absence by
   construction, not by masking (the C5 rule).
3. **Within-tenant writes use RLS-scoped DML**, not a function-per-mutation.
   Every authenticated request pins `app.company_id` from the verified session, so
   `INSERT`/`UPDATE` run under RLS (`USING` + `WITH CHECK`). The only `SECURITY
   DEFINER` paths are the cross-tenant auth bootstrap (login/session lookup) and the
   append-only audit writer.
4. **Directory pagination is keyset/cursor**, ordered by `(full_name, id)` — stable
   and O(page), not OFFSET. First page is an **Index Only Scan** (no full-table
   load). Substring search uses a **composite GIN** (`btree_gin(company_id)` +
   `gin_trgm_ops(full_name/emp_no)`) so search stays index-driven per tenant at scale.
5. **TBC governance values default conservatively and live in config/data**, never
   in code: A3 role sets, site-scope, maker/checker roles, page size — all overridable
   without a deploy (see *Configuration*).

## Security model

| Concern | Enforcement |
|--|--|
| **Tenant isolation (UNI-04/05)** | RLS on **every** tenant table; policy `company_id = current_company()`. The app connects as the **non-superuser** `hcmos_app`, so RLS constrains it. `app.company_id` is `SET LOCAL` from the verified session per request. Re-asserted by tests against every table, old and new. |
| **Site-scope (EMP-02)** | Additional server check **on top of** RLS: site-scoped roles are filtered to their own `site_id` **in SQL**; an out-of-site profile is `404` **before** any confidential table is touched. |
| **A3 confidentiality (C5)** | Permission map (config-driven). Forbidden confidential tables are not queried → keys absent. |
| **Separation of duties (SOD-03)** | Maker-checker queue; an approval requires a permitted checker **and** `checker ≠ maker`. |
| **Audit** | Append-only, per-tenant SHA-256 hash chain; `UPDATE`/`DELETE` blocked by trigger. Sign-in, reset, lockout, change submit/approve/decline all recorded. |
| **Secrets** | scrypt password/PIN hashing; RFC-6238 TOTP; PINs bound to the device. |

## Endpoints

**Slice 1:** `POST /auth/console`, `POST /auth/field`, `POST /auth/reset/password`,
`POST /auth/reset/pin`, `GET /me/landing`, `GET /me/profile/:id`, `POST /action/:name`.

**Slice 2 — Employee Master:**

| Endpoint | AC | Rule |
|--|--|--|
| `GET /employees?q&site&dept&status&cursor&limit` | EMP-02, UNI-02 | tenant-scoped, keyset-paginated; site-scoped roles get only their site (in SQL); `R08/R09/R12/R13` → 403 |
| `GET /employees/:id` | EMP-01, SOD-03, A3 | site check → 404 before any confidential query; A3 map builds the body; forbidden fields absent; pending changes surfaced as a flag |
| `POST /employees/:id/change` | EMP-03, UNI-06 | writes a `pending` `field_change` (employee NOT mutated); audited; idempotent on `idempotency_key` for offline sync |
| `POST /field-change/:id/approve` | EMP-03, SOD-03 | permitted checker **and** checker ≠ maker; applies `after`; audited |
| `POST /field-change/:id/decline` | EMP-03 | permitted checker; stored value unchanged; audited |
| `GET /employees/:id/documents` | DOC, A3 | medical/permit docs follow the medical A3 set |

## Tests (25, all green)

Slice 1: AC-AUTH-01..06, the four Section 17 tests, lockout, audit-chain integrity.
Slice 2 (`test/employees.test.js`):

1. **Confidential absence (A3)** — proven by key-absence (`'basic_pay' not in body`), pay/medical/disciplinary.
2. **Site-scope** — scoped role lists only its site (every page); out-of-site profile → 404 with a SQL spy asserting **no** query hit `employee_pay`/`employee_medical`.
3. **Maker-checker + SoD** — pending does not mutate; approve-as-maker refused; approve-as-different-checker applies; both events on the audit chain.
4. **No-directory roles** — R08/R09/R12/R13 → 403 on every `/employees*` route.
5. **Large-data** — 5,200 employees; bounded, stable, non-overlapping pages; status/site filters hold; non-active lifecycle states still listed.
   Plus **tenant-isolation carryover** against all seven new tables.

## Configuration (per-tenant `config` table + `site_scope` data)

`a3.pay.roles`, `a3.medical.roles`, `a3.disciplinary.roles`, `directory.deny.roles`,
`field_change.makers[.field]`, `field_change.checkers[.field]`, `employees.page_size`,
`employees.page_max`, plus the Slice 1 lockout/owner/ttl keys. Site-scope per role
lives in the `site_scope` table.

**Decided defaults for the 4 July [TBC] items** (conservative least-privilege; flip in config/data when governance confirms):
- `a3.pay.roles = R07,R09,R11` (R08 **not** added by default).
- `a3.medical.roles = R05,R06,R10` (R11 **not** added by default).
- `site_scope.R05 = true` (HSE is site-based in mining).
- `field_change.makers = R02,R03,R04`, `checkers = R03,R04,R11`.
- `employees.page_size = 50`.

## Open assumptions to confirm before launch

- **A2 landing map** (`src/roles.js`) is a documented least-privilege derivation —
  the design `HCMOS Auth Flow.html` ROLES table was not delivered to this repo. The
  enforcement mechanism is final; the specific module-per-role rows are provisional.
- The A3 confidential-field **rules** are verbatim from the pack and are final.

## Production readiness — required before go-live

These are decisions/operational items beyond what tests can prove here. They are
called out so they are not mistaken as done:

1. **Replace the pure-Node Postgres driver.** `src/pg.js` exists only because this
   environment has no package registry. It uses local `trust` auth and lacks TLS and
   SCRAM. In production, set `DATABASE_URL` and use `node-postgres` (`pg`) with TLS +
   `scram-sha-256`; the data layer is isolated to `src/pg.js`/`src/db.js` so the swap
   is contained. **This is the single biggest pre-launch item.**
2. **PII at rest.** `bank_account`, medical, `home_address` — add column/disk
   encryption and key management; A3 governs read visibility, not storage.
3. **Connection pool & horizontal scale.** Tune pool size; run multiple app
   instances behind a balancer for 10k users; add `statement_timeout` and
   idle-in-transaction timeouts.
4. **Observability & limits.** Structured request logging, metrics, tracing; request
   rate-limiting in front of the lockout control.
5. **Operations.** Automated backups + PITR; a periodic audit hash-chain verification
   job with tamper alerting; secrets via a manager (not `src/dbconfig.js` defaults).

## Layout

```
db/migrations/   001 auth · 002 employee master · 003 search index (versioned, additive)
scripts/         setup-db · migrate (runner) · seed · session-start
src/pg.js        pure-Node Postgres client + pool        src/db.js     withTenant/query/withOwner (+ SQL spy)
src/crypto.js    scrypt + TOTP + tokens                  src/roles.js  A2 landing + RBAC matrix
src/config.js    per-tenant config defaults/readers      src/a3.js     A3 confidential assembler (shared)
src/auth.js      Slice 1 auth service                    src/employees.js  Slice 2 directory/profile/maker-checker
src/server.js    HTTP API (Node http only)
test/            fixtures · helpers · auth · section17 · employees
```
