-- ===========================================================================
-- 034 — geofence sign-error guard + forward-only audit source_ip (Kira Wave 4)
-- ===========================================================================

-- 4.3 — a geofence centre MUST sit inside Tanzania. A dropped minus sign (the
-- Dar Yard 6.856552 that would have placed the zone 1,513 km away in Ethiopia
-- and silently locked out 67 staff) must FAIL LOUDLY at INSERT, never at
-- clock-in. Clean any pre-existing out-of-bounds zones (demo/bad data) first so
-- the constraint can be added, then guard every future insert/update.
DELETE FROM geofence_zone
 WHERE center_lat NOT BETWEEN -11.75 AND -0.95
    OR center_lng NOT BETWEEN 29.3 AND 40.5;

ALTER TABLE geofence_zone DROP CONSTRAINT IF EXISTS geofence_zone_tz_bounds;
ALTER TABLE geofence_zone ADD CONSTRAINT geofence_zone_tz_bounds CHECK (
  center_lat BETWEEN -11.75 AND -0.95 AND center_lng BETWEEN 29.3 AND 40.5);

-- ── Forward-only audit forensics (Kira 2026-07-13) ──────────────────────────
-- A system holding 1,029 people's bank details must record WHERE a sign-in came
-- from and WHETHER a second factor was presented. Both columns are NEW and are
-- NOT part of the hash payload (company|actor|role|action|entity|entity_id|ts|
-- before|after), so historic rows keep NULL and the chain is untouched by
-- construction — a rewrite of the hashed columns would break it, an added
-- unhashed column cannot.
ALTER TABLE audit ADD COLUMN IF NOT EXISTS source_ip     text;
ALTER TABLE audit ADD COLUMN IF NOT EXISTS mfa_presented boolean;

-- audit is truly append-only (an UPDATE trigger blocks any mutation), so the
-- forensic columns must be written AT INSERT time. audit_append gains two
-- OPTIONAL trailing params, stored in the new columns but DELIBERATELY EXCLUDED
-- from the hash payload — every existing 8-arg caller keeps working unchanged
-- (defaults NULL), and the chain recompute (which reads only the 9 hashed
-- fields) is untouched by construction.
-- Drop the original 8-arg version so there is exactly ONE audit_append; a
-- separate overload would make audit_append(…8 untyped literals…) ambiguous.
-- Every existing 8-arg call site resolves to the 10-arg version via its
-- DEFAULT NULL trailing params. plpgsql bodies resolve the call at execution,
-- so dropping the old signature does not break the functions that call it.
DROP FUNCTION IF EXISTS audit_append(uuid,text,text,text,text,text,jsonb,jsonb);
CREATE OR REPLACE FUNCTION audit_append(
  p_company uuid, p_actor text, p_role text, p_action text,
  p_entity text, p_entity_id text, p_before jsonb, p_after jsonb,
  p_source_ip text DEFAULT NULL, p_mfa_presented boolean DEFAULT NULL)
RETURNS TABLE(seq bigint, hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_prev text; v_ts timestamptz := now(); v_payload text; v_hash text; v_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hcmos_audit:' || p_company::text));
  SELECT a.hash INTO v_prev FROM audit a WHERE a.company_id = p_company ORDER BY a.seq DESC LIMIT 1;
  IF v_prev IS NULL THEN v_prev := repeat('0', 64); END IF;
  -- HASH PAYLOAD IS UNCHANGED — source_ip / mfa_presented are NOT included.
  v_payload := concat_ws('|',
      p_company::text, coalesce(p_actor,''), coalesce(p_role,''), p_action,
      coalesce(p_entity,''), coalesce(p_entity_id,''), v_ts::text,
      coalesce(p_before::text,''), coalesce(p_after::text,''));
  v_hash := encode(sha256(convert_to(v_prev || v_payload, 'UTF8')), 'hex');
  INSERT INTO audit(company_id, actor, role, action, entity, entity_id, ts,
                    before, after, prev_hash, hash, source_ip, mfa_presented)
  VALUES (p_company, p_actor, p_role, p_action, p_entity, p_entity_id, v_ts,
          p_before, p_after, v_prev, v_hash, p_source_ip, p_mfa_presented)
  RETURNING audit.seq INTO v_seq;
  seq := v_seq; hash := v_hash; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION audit_append(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_append(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean) TO hcmos_app;

-- consoleLogin records the source IP + whether a factor was presented, via the
-- new audit_append params — the auth.signin row carries them at insert.
DROP FUNCTION IF EXISTS auth_console_success(uuid, text, int);
CREATE OR REPLACE FUNCTION auth_console_success(
  p_user uuid, p_token_hash text, p_ttl_secs int,
  p_source_ip text DEFAULT NULL, p_mfa_presented boolean DEFAULT NULL)
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
          jsonb_build_object('channel','console','user_id',p_user),
          p_source_ip, p_mfa_presented);

  session_id := v_sid; company_id := v_company; role_code := v_role; expires_at := v_exp; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION auth_console_success(uuid, text, int, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_console_success(uuid, text, int, text, boolean) TO hcmos_app;
