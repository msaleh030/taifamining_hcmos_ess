-- ===========================================================================
-- 033 — the field-session bleed, D3/D4 (Kira Wave 1, 2026-07-13)
-- ===========================================================================
-- RULING (Job 3, accepted): R01 describes the PERSON; R13 describes the
-- SESSION. Privilege follows the STRENGTH OF THE AUTHENTICATION, not the
-- identity of the user. A device+PIN session is ALWAYS R13 — own record only —
-- even when the person also holds a console account. A manager approves on
-- mobile by authenticating FULLY (email+password+MFA → their console role);
-- never by PIN.
--
-- 1.2 — auth_field_success no longer takes its role from the employee's console
-- account. The console lookup survives ONLY to link the session to the person
-- for own-record resolution; the ROLE is p_default_role (R13) unconditionally.
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

  -- IDENTITY ONLY — link to the person's console account if one exists (for
  -- own-record resolution). The role is NEVER read from it (D3/D4 fix).
  SELECT id INTO v_user FROM app_user
    WHERE employee_id = v_emp ORDER BY (status='active') DESC, created_at ASC LIMIT 1;
  v_role := p_default_role;                         -- ALWAYS R13, whatever the person is

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

-- 1.4 — HARDEN R13: site-bound (a field session sees only its own site's data
-- where any list ever surfaces), and it STAYS directory-denied (config, already
-- R12,R13,R15,R16). The self-service surface is own-record only.
INSERT INTO site_scope (role_code, scoped) VALUES ('R13', true)
ON CONFLICT (role_code) DO UPDATE SET scoped = true;

-- 1.5 — revoke EVERY live field session. Every device holder re-enrols; no
-- session minted under the old bleed survives.
UPDATE session SET revoked_at = now()
 WHERE device_id IS NOT NULL AND revoked_at IS NULL;
