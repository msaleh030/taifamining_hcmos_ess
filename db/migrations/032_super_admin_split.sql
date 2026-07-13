-- ===========================================================================
-- 032 — SPLIT Super Admin from System Administrator (Kira, 2026-07-13)
-- ===========================================================================
-- Until now BOTH Rajesh's System Administrator role and the two super accounts
-- were R12 rank 90, distinguished only by employee_id IS NULL — not a security
-- boundary. The split:
--   • explicit app_user.is_super_admin column (NEVER gate on employee_id);
--   • the two named super accounts are the ONLY true rows;
--   • R12 System Administrator drops from rank 90 to 60 — the IT tier: above
--     the site managers (50), below the people-data tier (R11/R14/R15/R16 at
--     70) — so a sysadmin can no longer rotate an executive's or the Head of
--     HR's credential, and NEVER a super's;
--   • Super Admin takes rank 100 via the column (config 'auth.super.rank'),
--     applied in the reset lattice in src/auth.js;
--   • super accounts are MFA-MANDATORY unconditionally — the setup-phase
--     auth.mfa.required=0 convenience no longer applies to them (enforced in
--     consoleLogin via the extended auth_lookup_console below).
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS is_super_admin boolean NOT NULL DEFAULT false;

-- (b) Exactly the two named super accounts — an explicit list, not a heuristic.
UPDATE app_user SET is_super_admin = true
 WHERE lower(email) IN ('mohammed@railgrid.tz', 'admin@taifamining.tz');

-- (e) Rebuild the rank lattice EXPLICITLY (stated to Kira before applying):
--   10  R01 Employee, R13 Field Operator
--   20  R08/R09/R10 (retired codes, kept defined)
--   30  R02 Supervisor, R03 HR Officer, R05 (retired)
--   50  R04 HR Manager, R06 SHEQ Manager, R07 Payroll Officer
--   60  R12 System Administrator  (DOWN from 90 — the IT tier)
--   70  R11 Head of HR, R14 CEO, R15 Finance Manager, R16 CFC
--  100  Super Admin (is_super_admin column, 'auth.super.rank' key)
UPDATE config SET value =
  'R01:10,R13:10,R08:20,R09:20,R10:20,R02:30,R03:30,R05:30,R04:50,R06:50,R07:50,R12:60,R11:70,R14:70,R15:70,R16:70'
 WHERE key = 'auth.role.rank';

-- The console lookup now surfaces the flag so login can enforce super-MFA and
-- the reset lattice can rank the actor. Same SECURITY DEFINER shape as 001.
DROP FUNCTION IF EXISTS auth_lookup_console(text);
CREATE FUNCTION auth_lookup_console(p_email text)
RETURNS TABLE(user_id uuid, company_id uuid, role_code text, status text,
              password_hash text, mfa_secret text,
              failed_count int, locked_until timestamptz, company_status text,
              is_super_admin boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.company_id, u.role_code, u.status, u.password_hash, u.mfa_secret,
         u.failed_count, u.locked_until, t.status, u.is_super_admin
    FROM app_user u JOIN tenant t ON t.company_id = u.company_id
   WHERE lower(u.email) = lower(p_email)
$$;
REVOKE ALL ON FUNCTION auth_lookup_console(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_console(text) TO hcmos_app;
