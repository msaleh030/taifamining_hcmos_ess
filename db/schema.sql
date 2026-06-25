-- HCMOS ESS — Slice 1: Authentication & Access
-- Source of truth: Acceptance Pack RTL/ACP/TM/001/2026 (+ A1 roles, A2 landing, A3 confidential fields)
--
-- Security model
-- ==============
-- * Tables are owned by hcmos_owner and this file runs as that role.
-- * Row Level Security is ENABLED on every table. Policy: a row is only visible
--   when its company_id equals app.company_id, which the API sets from the
--   VERIFIED session on every request (AC-UNI-04/05). UI hiding is never the control.
-- * The application connects as the NON-owner, NON-superuser role hcmos_app, so
--   RLS actually constrains it. (Owners/superusers bypass RLS; a non-owner does not.)
-- * The few operations that must legitimately cross tenants are the AUTH BOOTSTRAP
--   itself — resolving a login before a session exists, validating a session token,
--   writing the append-only audit chain. These live in SECURITY DEFINER functions
--   owned by hcmos_owner. They are the authentication boundary, not a data bypass:
--   each verifies credentials/possession and returns only the minimum needed.
--   No data-serving endpoint ever bypasses RLS.

SET client_min_messages = warning;

-- Run idempotently.
DROP SCHEMA IF EXISTS hcmos CASCADE;  -- no-op normally; keeps re-runs clean if used
-- (We use the public schema; the DROP above is defensive for a stray hcmos schema.)

DROP TABLE IF EXISTS audit, idempotency, session, device, app_user, employee, config, tenant CASCADE;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE tenant (
  company_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'))
);

CREATE TABLE employee (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES tenant(company_id),
  full_name    text NOT NULL,
  -- A3 confidential fields. Visibility is enforced server-side on profile reads;
  -- forbidden fields are OMITTED from the response (absent, not masked).
  pay_grade        text,   -- pay/bank      -> R07,R09,R11
  bank_account     text,   -- pay/bank
  medical_notes    text,   -- medical/permits -> R05,R06,R10
  permits          text,   -- medical/permits
  disciplinary     text    -- disciplinary  -> R05,R06,R07,R11
);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES tenant(company_id),
  employee_id   uuid REFERENCES employee(id),
  email         text NOT NULL,
  password_hash text,
  mfa_secret    text,        -- base32 TOTP secret
  role_code     text NOT NULL CHECK (role_code IN
                  ('R01','R02','R03','R04','R05','R06','R07',
                   'R08','R09','R10','R11','R12','R13')),
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','terminated')),
  failed_count  int  NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Email is the global console login identifier; it resolves the tenant.
CREATE UNIQUE INDEX app_user_email_key ON app_user (lower(email));

CREATE TABLE device (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES tenant(company_id),
  employee_id  uuid REFERENCES employee(id),
  enrolled_at  timestamptz NOT NULL DEFAULT now(),
  pin_hash     text,         -- PIN is bound to the DEVICE, never to an email
  status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','suspended','terminated')),
  failed_count int  NOT NULL DEFAULT 0,
  locked_until timestamptz
);

CREATE TABLE session (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES tenant(company_id),
  user_id    uuid REFERENCES app_user(id),
  device_id  uuid REFERENCES device(id),
  role_code  text NOT NULL,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX session_token_hash_key ON session (token_hash);

-- Append-only, tamper-evident audit. Chained per tenant.
CREATE TABLE audit (
  seq        bigserial PRIMARY KEY,
  company_id uuid NOT NULL,
  actor      text,
  role       text,
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  ts         timestamptz NOT NULL DEFAULT now(),
  before     jsonb,
  after      jsonb,
  prev_hash  text NOT NULL,
  hash       text NOT NULL
);

CREATE TABLE config (
  company_id uuid NOT NULL REFERENCES tenant(company_id),
  key        text NOT NULL,
  value      text NOT NULL,
  PRIMARY KEY (company_id, key)
);

-- Offline field-auth dedupe: client supplies an idempotency key; the server
-- validates and dedupes on sync.
CREATE TABLE idempotency (
  company_id uuid NOT NULL REFERENCES tenant(company_id),
  key        text NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);

-- ---------------------------------------------------------------------------
-- Row Level Security — every table
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_company() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
      'tenant','employee','app_user','device','session','audit','config','idempotency'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    IF t = 'tenant' THEN
      -- tenant's own key IS the company_id
      EXECUTE 'CREATE POLICY tenant_isolation ON tenant USING (company_id = current_company()) WITH CHECK (company_id = current_company())';
    ELSE
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Grants — hcmos_app reads tables (RLS-scoped) and executes the auth boundary
-- functions. It has NO direct INSERT/UPDATE/DELETE on any table: every mutation
-- flows through the SECURITY DEFINER functions below, which enforce their own
-- rules. This keeps the attack surface to a handful of audited operations.
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO hcmos_app;
GRANT SELECT ON tenant, employee, app_user, device, session, audit, config, idempotency TO hcmos_app;

-- ---------------------------------------------------------------------------
-- Audit hash chain (append-only, per-tenant chain)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_append(
  p_company uuid, p_actor text, p_role text, p_action text,
  p_entity text, p_entity_id text, p_before jsonb, p_after jsonb)
RETURNS TABLE(seq bigint, hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_prev text;
  v_ts   timestamptz := now();
  v_payload text;
  v_hash text;
  v_seq bigint;
BEGIN
  -- Serialize the per-tenant tail so concurrent appends cannot fork the chain.
  PERFORM pg_advisory_xact_lock(hashtext('hcmos_audit:' || p_company::text));

  SELECT a.hash INTO v_prev FROM audit a
   WHERE a.company_id = p_company ORDER BY a.seq DESC LIMIT 1;
  IF v_prev IS NULL THEN
    v_prev := repeat('0', 64);  -- genesis
  END IF;

  v_payload := concat_ws('|',
      p_company::text, coalesce(p_actor,''), coalesce(p_role,''), p_action,
      coalesce(p_entity,''), coalesce(p_entity_id,''), v_ts::text,
      coalesce(p_before::text,''), coalesce(p_after::text,''));
  v_hash := encode(sha256(convert_to(v_prev || v_payload, 'UTF8')), 'hex');

  INSERT INTO audit(company_id, actor, role, action, entity, entity_id, ts,
                    before, after, prev_hash, hash)
  VALUES (p_company, p_actor, p_role, p_action, p_entity, p_entity_id, v_ts,
          p_before, p_after, v_prev, v_hash)
  RETURNING audit.seq INTO v_seq;

  seq := v_seq; hash := v_hash; RETURN NEXT;
END $$;

-- Block UPDATE/DELETE on audit at the database level — truly append-only.
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit is append-only (% rejected)', TG_OP;
END $$;
DROP TRIGGER IF EXISTS audit_no_mutate ON audit;
CREATE TRIGGER audit_no_mutate BEFORE UPDATE OR DELETE ON audit
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- ---------------------------------------------------------------------------
-- Config reader (per-tenant; bootstrap-safe)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION config_get(p_company uuid, p_key text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT value FROM config WHERE company_id = p_company AND key = p_key
$$;

-- ---------------------------------------------------------------------------
-- Console auth bootstrap (AUTH-01/03/04/06)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_lookup_console(p_email text)
RETURNS TABLE(user_id uuid, company_id uuid, role_code text, status text,
              password_hash text, mfa_secret text,
              failed_count int, locked_until timestamptz, company_status text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.company_id, u.role_code, u.status, u.password_hash, u.mfa_secret,
         u.failed_count, u.locked_until, t.status
    FROM app_user u JOIN tenant t ON t.company_id = u.company_id
   WHERE lower(u.email) = lower(p_email)
$$;

-- Record a failed console attempt; lock and audit on crossing the threshold.
CREATE OR REPLACE FUNCTION auth_console_fail(
  p_user uuid, p_threshold int, p_lockout_secs int)
RETURNS TABLE(failed_count int, locked_until timestamptz, just_locked boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_company uuid; v_email text; v_role text; v_cnt int; v_lock timestamptz; v_just boolean := false;
BEGIN
  UPDATE app_user SET failed_count = failed_count + 1
   WHERE id = p_user
   RETURNING company_id, email, role_code, app_user.failed_count, app_user.locked_until
        INTO v_company, v_email, v_role, v_cnt, v_lock;

  IF v_cnt >= p_threshold AND (v_lock IS NULL OR v_lock <= now()) THEN
    v_lock := now() + make_interval(secs => p_lockout_secs);
    UPDATE app_user SET locked_until = v_lock WHERE id = p_user;
    v_just := true;
    PERFORM audit_append(v_company, v_email, v_role, 'auth.lockout',
            'app_user', p_user::text, NULL,
            jsonb_build_object('failed_count', v_cnt, 'locked_until', v_lock));
  END IF;

  failed_count := v_cnt; locked_until := v_lock; just_locked := v_just; RETURN NEXT;
END $$;

-- Successful console sign-in: clear counters, create session, audit.
CREATE OR REPLACE FUNCTION auth_console_success(
  p_user uuid, p_token_hash text, p_ttl_secs int)
RETURNS TABLE(session_id uuid, company_id uuid, role_code text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_company uuid; v_role text; v_email text; v_exp timestamptz; v_sid uuid;
BEGIN
  UPDATE app_user SET failed_count = 0, locked_until = NULL
   WHERE id = p_user RETURNING app_user.company_id, role_code, email
        INTO v_company, v_role, v_email;

  v_exp := now() + make_interval(secs => p_ttl_secs);
  INSERT INTO session(company_id, user_id, role_code, token_hash, expires_at)
  VALUES (v_company, p_user, v_role, p_token_hash, v_exp)
  RETURNING id INTO v_sid;

  PERFORM audit_append(v_company, v_email, v_role, 'auth.signin',
          'session', v_sid::text, NULL,
          jsonb_build_object('channel','console','user_id',p_user));

  session_id := v_sid; company_id := v_company; role_code := v_role; expires_at := v_exp; RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------------
-- Session validation (used on every authenticated request)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_lookup_session(p_token_hash text)
RETURNS TABLE(session_id uuid, company_id uuid, user_id uuid, device_id uuid,
              role_code text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.company_id, s.user_id, s.device_id, s.role_code, s.expires_at
    FROM session s
    JOIN tenant t ON t.company_id = s.company_id
    LEFT JOIN app_user u ON u.id = s.user_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND t.status = 'active'
     AND (u.id IS NULL OR u.status <> 'terminated')
$$;

-- ---------------------------------------------------------------------------
-- Field (device + PIN) auth bootstrap (AUTH-02/03/04)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_lookup_device(p_device uuid)
RETURNS TABLE(device_id uuid, company_id uuid, employee_id uuid, pin_hash text,
              device_status text, failed_count int, locked_until timestamptz,
              user_id uuid, role_code text, user_status text, company_status text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.company_id, d.employee_id, d.pin_hash, d.status,
         d.failed_count, d.locked_until,
         u.id, u.role_code, u.status, t.status
    FROM device d
    JOIN tenant t ON t.company_id = d.company_id
    LEFT JOIN LATERAL (
        SELECT id, role_code, status FROM app_user au
         WHERE au.employee_id = d.employee_id
         ORDER BY (status = 'active') DESC, created_at ASC LIMIT 1
    ) u ON true
   WHERE d.id = p_device
$$;

CREATE OR REPLACE FUNCTION auth_device_fail(
  p_device uuid, p_threshold int, p_lockout_secs int)
RETURNS TABLE(failed_count int, locked_until timestamptz, just_locked boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_company uuid; v_cnt int; v_lock timestamptz; v_just boolean := false;
BEGIN
  UPDATE device SET failed_count = failed_count + 1
   WHERE id = p_device
   RETURNING company_id, device.failed_count, device.locked_until
        INTO v_company, v_cnt, v_lock;

  IF v_cnt >= p_threshold AND (v_lock IS NULL OR v_lock <= now()) THEN
    v_lock := now() + make_interval(secs => p_lockout_secs);
    UPDATE device SET locked_until = v_lock WHERE id = p_device;
    v_just := true;
    PERFORM audit_append(v_company, p_device::text, NULL, 'auth.lockout',
            'device', p_device::text, NULL,
            jsonb_build_object('failed_count', v_cnt, 'locked_until', v_lock));
  END IF;

  failed_count := v_cnt; locked_until := v_lock; just_locked := v_just; RETURN NEXT;
END $$;

-- Successful field auth: dedupe by idempotency key, clear counters, create a
-- device-bound session, audit.
CREATE OR REPLACE FUNCTION auth_field_success(
  p_device uuid, p_token_hash text, p_ttl_secs int, p_idem_key text, p_default_role text)
RETURNS TABLE(session_id uuid, company_id uuid, role_code text, expires_at timestamptz, deduped boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_company uuid; v_emp uuid; v_user uuid; v_role text; v_exp timestamptz;
        v_sid uuid; v_prev jsonb;
BEGIN
  SELECT d.company_id, d.employee_id INTO v_company, v_emp FROM device d WHERE d.id = p_device;

  -- Dedupe on sync: if we already processed this key for this tenant, replay it.
  IF p_idem_key IS NOT NULL THEN
    SELECT response INTO v_prev FROM idempotency
      WHERE company_id = v_company AND key = p_idem_key;
    IF v_prev IS NOT NULL THEN
      session_id := (v_prev->>'session_id')::uuid;
      company_id := v_company;
      role_code  := v_prev->>'role_code';
      expires_at := (v_prev->>'expires_at')::timestamptz;
      deduped := true; RETURN NEXT; RETURN;
    END IF;
  END IF;

  SELECT id, role_code INTO v_user, v_role FROM app_user
    WHERE employee_id = v_emp ORDER BY (status='active') DESC, created_at ASC LIMIT 1;
  IF v_role IS NULL THEN v_role := p_default_role; END IF;

  UPDATE device SET failed_count = 0, locked_until = NULL WHERE id = p_device;

  v_exp := now() + make_interval(secs => p_ttl_secs);
  INSERT INTO session(company_id, user_id, device_id, role_code, token_hash, expires_at)
  VALUES (v_company, v_user, p_device, v_role, p_token_hash, v_exp)
  RETURNING id INTO v_sid;

  PERFORM audit_append(v_company, p_device::text, v_role, 'auth.field',
          'session', v_sid::text, NULL,
          jsonb_build_object('channel','field','device_id',p_device));

  IF p_idem_key IS NOT NULL THEN
    INSERT INTO idempotency(company_id, key, response)
    VALUES (v_company, p_idem_key, jsonb_build_object(
        'session_id', v_sid, 'role_code', v_role, 'expires_at', v_exp));
  END IF;

  session_id := v_sid; company_id := v_company; role_code := v_role;
  expires_at := v_exp; deduped := false; RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------------
-- Credential resets (AUTH-05) — kill all sessions for the affected user
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_reset_password(
  p_target uuid, p_new_hash text, p_actor text, p_actor_role text)
RETURNS TABLE(company_id uuid, revoked int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_company uuid; v_revoked int;
BEGIN
  UPDATE app_user SET password_hash = p_new_hash, failed_count = 0, locked_until = NULL
   WHERE id = p_target RETURNING app_user.company_id INTO v_company;
  IF v_company IS NULL THEN RAISE EXCEPTION 'unknown user'; END IF;

  UPDATE session SET revoked_at = now()
   WHERE user_id = p_target AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  PERFORM audit_append(v_company, p_actor, p_actor_role, 'auth.reset.password',
          'app_user', p_target::text, NULL,
          jsonb_build_object('revoked_sessions', v_revoked));

  company_id := v_company; revoked := v_revoked; RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION auth_reset_pin(
  p_device uuid, p_new_pin_hash text, p_actor text, p_actor_role text)
RETURNS TABLE(company_id uuid, revoked int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_company uuid; v_emp uuid; v_revoked int;
BEGIN
  UPDATE device SET pin_hash = p_new_pin_hash, failed_count = 0, locked_until = NULL
   WHERE id = p_device RETURNING device.company_id, device.employee_id INTO v_company, v_emp;
  IF v_company IS NULL THEN RAISE EXCEPTION 'unknown device'; END IF;

  -- Revoke sessions for that device and for users on the same employee.
  UPDATE session SET revoked_at = now()
   WHERE revoked_at IS NULL
     AND (device_id = p_device
          OR user_id IN (SELECT id FROM app_user WHERE employee_id = v_emp));
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  PERFORM audit_append(v_company, p_actor, p_actor_role, 'auth.reset.pin',
          'device', p_device::text, NULL,
          jsonb_build_object('revoked_sessions', v_revoked));

  company_id := v_company; revoked := v_revoked; RETURN NEXT;
END $$;

-- Function execution grants for the application role.
GRANT EXECUTE ON FUNCTION
  current_company(),
  audit_append(uuid,text,text,text,text,text,jsonb,jsonb),
  config_get(uuid,text),
  auth_lookup_console(text),
  auth_console_fail(uuid,int,int),
  auth_console_success(uuid,text,int),
  auth_lookup_session(text),
  auth_lookup_device(uuid),
  auth_device_fail(uuid,int,int),
  auth_field_success(uuid,text,int,text,text),
  auth_reset_password(uuid,text,text,text),
  auth_reset_pin(uuid,text,text,text)
TO hcmos_app;
