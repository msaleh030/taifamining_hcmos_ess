# UAT role walkthroughs — differentiated workflows per account

Every behaviour below is server-enforced (A2 landing matrix, RBAC actions, A3
field tiers, site scope, pay gate, expat gate) and pinned by the test suite —
the screens render what `/me/landing` and the role-scoped endpoints return,
never a client-side guess. Use this as the per-tester script.

## Before testing — credentials and lockout

- Credentials: `/root/uat-credentials.txt` on the box (600). The file
  ACCUMULATES generations — **always use the LAST block for an email** (earlier
  re-seeds left stale passwords above it).
- Five wrong attempts locks an account (Section 17 lockout). Check / clear:
  ```
  sudo -u postgres psql -d hcmos -c "SELECT email, failed_count, locked_until FROM app_user WHERE email='<email>'"
  sudo -u postgres psql -d hcmos -c "UPDATE app_user SET failed_count=0, locked_until=NULL WHERE email='<email>'"
  ```
- MFA is OFF (setup phase): login = email + password only. The UAT-week flip
  (`auth.mfa.required=1` + privileged-role floor) is one bundled change on
  Kira's word.

## What "empty" is correct vs wrong

- **KPI tiles on the Overview**: mostly "not available — names its missing
  input". CORRECT — KPI inputs (attendance events, reviews, incident logs) are
  not captured yet; figures are never fabricated.
- **Attendance / disciplinary / support / leave REQUESTS**: empty until
  testers generate activity. CORRECT.
- **Payroll amounts**: absent everywhere. CORRECT for now — the North Mara
  payroll workbook failed fail-closed controls (amount columns unreadable);
  waiting on a flat single-header export (Kira ↔ Taifa).
- **Directory, profiles, leave BALANCES, permits, org data**: MUST be
  populated (1,117 people; 1,003 master-enriched; opening balances at 5
  sites; 8 expat permit docs). If a role that should see these sees nothing,
  that is a bug — report it.
- **R12 / R15 / R16 seeing no people anywhere**: CORRECT — those roles are
  directory-DENIED by design (admins administer, finance ingests; neither
  browses people).

## Per-account scripts

### Omid Karambeck — R11 Head of HR (central)
Modules: dashboard, profile, payroll, performance, disciplinary, reports.
1. Directory: all six sites, 1,117 rows; open profiles — HR-tier fields
   (national_id) visible; NO bank/pay on the profile (pay lives behind the
   payroll/liability gate, which R11 passes).
2. Reports → leave liability register: allowed. Organogram: title-based
   reporting lines (by design; the file has no manager PFs).
3. EXPAT (only Omid): open an `is_expat` employee → raise a field change →
   it goes PENDING for Richard (R14) to decide. Expat permit docs visible on
   the profile documents list — for R11 alone.

### Cecilia Mtweve — R07 Payroll Officer (central)
Modules: dashboard, payroll, disciplinary, reports.
1. Liability register: allowed (the confidentiality probe pins this).
2. No profile/directory module on her landing; payroll amounts pending the
   payroll file fix.

### The four R03 HR Officers — site-bound, explicit site sets
Modules: dashboard, profile, leave, recruitment, training, health_safety,
medical, permits.
- **Yusuph Kabeza** → Mwadui only (379 rows).
- **Ali Mbarouk** → Head Office only (61 rows).
- **Ramadhan Mchomvu** → Nyanzaga only (305 rows).
- **Advera Speratus** → BOTH North Mara projects (196 + 109 rows) — the
  multi-site set; the two sites stay distinct, never merged.
1. Directory shows ONLY the officer's site set; a profile outside it is 404.
2. Leave balances of their site's people visible; raise a field change on a
   LOCAL employee (maker) — a different permitted role approves.
3. Pay/liability: 403 everywhere (confidentiality probe pins this).
4. EXPAT: any change on an `is_expat` employee → 403 "managed by the Head of
   HR only"; expat permit docs are hidden from the documents list.

### Baraka Nsemwa / Poonam Divecha — R04 HR Manager (central)
Modules: dashboard, profile, leave, recruitment, training, performance, reports.
1. Directory: all sites. Maker AND checker for local field changes (never
   both on the same change — SoD refuses self-approval).
2. Leave approvals (leave.approve).
3. EXPAT: refused both ways (maker 403, checker 403).

### Maurice Mwendabai — R06 SHEQ Manager (central)
Modules: dashboard, health_safety, permits, medical, disciplinary, reports.
1. Business permits/licences of LOCAL employees visible; expat permits hidden.
2. Medical docs visible (A3 medical set). Disciplinary issuer.

### Omar Omar (R15 maker) / Viswa Medhuru (R16 checker) — ingestion SoD
Modules: dashboard, exact/ingestion, reports. Directory: DENIED by design.
1. Omar submits an ingest batch (preview → submit); Viswa approves.
2. Viswa approving Omar's batch: allowed. Anyone approving their OWN batch:
   403. Control-total mismatch: hard block.

### Rajesh Chohan — R12 System Administrator (central)
Modules: dashboard, admin, reports. Directory: DENIED by design — empty
people views are CORRECT for R12.
1. Admin: user/security administration. Cannot reset a higher-ranked account
   (rank lattice — probe-pinned).

### Richard Tainton — R14 CEO / Executive (central, read-only)
Modules: dashboard, reports.
1. Org-wide reports/aggregates; NO individual pay (LI-4), no admin actions.
2. EXPAT CHECKER (only Richard): the pending expat change Omid raised appears
   for decision; approve applies it, decline discards. Richard cannot RAISE
   expat changes and is not a checker for locals.

## The expat two-person flow (test as a pair)
1. Omid opens an expatriate profile, raises a change (e.g. phone).
2. Anyone else trying to decide it → 403. Omid deciding it → 403 (SoD).
3. Richard approves → the change applies. That is the whole chain:
   **only Omid raises, only Richard decides.**
