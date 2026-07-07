-- ===========================================================================
-- 022 — Session/auth status hardening (bug hunt M1 + H2 defense-in-depth).
-- ===========================================================================
-- M1: auth_lookup_session accepted any non-'terminated' user and ignored device
-- status, so SUSPENDING a user (or REVOKING a device) did not kill their live
-- sessions until token expiry. Require an ACTIVE user and, for device-bound
-- (field) sessions, an ACTIVE device. A session with no user_id (pure field
-- bootstrap) still resolves, gated by its device.
CREATE OR REPLACE FUNCTION auth_lookup_session(p_token_hash text)
RETURNS TABLE(session_id uuid, company_id uuid, user_id uuid, device_id uuid,
              role_code text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.company_id, s.user_id, s.device_id, s.role_code, s.expires_at
    FROM session s
    JOIN tenant t ON t.company_id = s.company_id
    LEFT JOIN app_user u ON u.id = s.user_id
    LEFT JOIN device dv ON dv.id = s.device_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND t.status = 'active'
     AND (u.id IS NULL OR u.status = 'active')
     AND (s.device_id IS NULL OR dv.status = 'active')
$$;

-- H2 (defense-in-depth): auth_field_success bound the employee's app_user role
-- to the new session with NO status filter (ORDER BY status='active' only), so
-- a direct call could still bind a suspended user's role. The app layer already
-- refuses suspended users before this runs; make the SQL safe on its own too by
-- binding ONLY an active user, else falling back to the default field role.
CREATE OR REPLACE FUNCTION auth_field_success(
  p_device uuid, p_token_hash text, p_ttl_secs int, p_idem_key text, p_default_role text)
RETURNS TABLE(session_id uuid, company_id uuid, role_code text, expires_at timestamptz, deduped boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_company uuid; v_emp uuid; v_user uuid; v_role text; v_exp timestamptz;
        v_sid uuid; v_prev jsonb;
BEGIN
  SELECT d.company_id, d.employee_id INTO v_company, v_emp FROM device d WHERE d.id = p_device;

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

  -- Bind only an ACTIVE app_user; a suspended/terminated account is treated as
  -- "no console user", so the session takes the default field role, not theirs.
  SELECT id, role_code INTO v_user, v_role FROM app_user
    WHERE employee_id = v_emp AND status = 'active' ORDER BY created_at ASC LIMIT 1;
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
