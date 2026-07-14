-- ===========================================================================
-- 040 — Shared KIOSK device model (Kira rulings, 2026-07-14)
-- ===========================================================================
-- Two device models, DIFFERENT security postures:
--   personal: one device, one person, PIN + possession (unchanged, P1);
--   kiosk:    the device enrols to a SITE; the PIN identifies the PERSON;
--             the session is CLOCK-IN/OUT ONLY and dies with the punch.
--
-- 1. device: kiosks are site-enrolled. kind='kiosk' → employee_id NULL,
--    site_id NOT NULL, pin_hash NULL (the PIN is per-person, below).
ALTER TABLE device ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES site(id);
ALTER TABLE device ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'personal';
ALTER TABLE device DROP CONSTRAINT IF EXISTS device_kind_check;
ALTER TABLE device ADD CONSTRAINT device_kind_check CHECK (kind IN ('personal','kiosk'));

-- 2. Per-PERSON field PIN (kiosk attribution). Lockout counts per person, not
--    per device — a shared kiosk must not lock a whole site out on one
--    person's typos. Accessed ONLY through the SECURITY DEFINER auth functions.
CREATE TABLE IF NOT EXISTS field_pin (
  company_id   uuid NOT NULL REFERENCES tenant(company_id),
  employee_id  uuid PRIMARY KEY REFERENCES employee(id),
  pin_hash     text NOT NULL,
  failed_count int  NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 3. session: kiosk sessions are marked and carry the punched PERSON (they
--    have no app_user and their device maps to a site, not a person).
ALTER TABLE session ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'full';
ALTER TABLE session DROP CONSTRAINT IF EXISTS session_kind_check;
ALTER TABLE session ADD CONSTRAINT session_kind_check CHECK (kind IN ('full','kiosk'));
ALTER TABLE session ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES employee(id);

-- 4. attendance: punches carry direction, channel, capturing device, and the
--    kiosk photo EVIDENCE (a path to binary at rest — never base64 in the DB;
--    one photo, one attendance row, nothing pooled — TZ PDPA scoping).
--    photo_missing is meaningful for via='kiosk': false = photo stored,
--    true = camera failed/suppressed → punch still succeeded, record FLAGGED.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'in';
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_direction_check;
ALTER TABLE attendance ADD CONSTRAINT attendance_direction_check CHECK (direction IN ('in','out'));
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS via text NOT NULL DEFAULT 'personal';
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_via_check;
ALTER TABLE attendance ADD CONSTRAINT attendance_via_check CHECK (via IN ('personal','kiosk'));
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES device(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS photo_path text;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS photo_missing boolean;

-- 5. Kiosk auth functions (SECURITY DEFINER — the app role reaches device /
--    field_pin / session only through these).
CREATE OR REPLACE FUNCTION auth_lookup_kiosk(p_device uuid, p_employee uuid)
RETURNS TABLE(device_id uuid, company_id uuid, site_id uuid, device_kind text,
              device_status text, company_status text,
              employee_status text, employee_site uuid, full_name text, emp_no text,
              pin_hash text, failed_count int, locked_until timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.company_id, d.site_id, d.kind, d.status, t.status,
         e.status, e.site_id, e.full_name, e.emp_no,
         p.pin_hash, p.failed_count, p.locked_until
    FROM device d
    JOIN tenant t ON t.company_id = d.company_id
    LEFT JOIN employee e ON e.id = p_employee AND e.company_id = d.company_id
    LEFT JOIN field_pin p ON p.employee_id = e.id
   WHERE d.id = p_device
$$;
GRANT EXECUTE ON FUNCTION auth_lookup_kiosk(uuid, uuid) TO hcmos_app;

-- The site roster a kiosk may show pre-auth: ACTIVE workers of the KIOSK'S
-- site only, minimal fields (name + staff number — what a gate list shows).
CREATE OR REPLACE FUNCTION auth_kiosk_roster(p_device uuid, p_cap int, p_q text)
RETURNS TABLE(employee_id uuid, emp_no text, full_name text, site_name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id, e.emp_no, e.full_name, s.name
    FROM device d
    JOIN tenant t ON t.company_id = d.company_id AND t.status = 'active'
    JOIN site s ON s.id = d.site_id
    JOIN employee e ON e.site_id = d.site_id AND e.company_id = d.company_id
   WHERE d.id = p_device AND d.kind = 'kiosk' AND d.status = 'active'
     AND e.status = 'active'
     AND (p_q IS NULL OR e.full_name ILIKE '%'||p_q||'%' OR e.emp_no ILIKE '%'||p_q||'%')
   ORDER BY e.full_name
   LIMIT p_cap
$$;
GRANT EXECUTE ON FUNCTION auth_kiosk_roster(uuid, int, text) TO hcmos_app;

-- Per-person PIN failure counting (+ lockout), mirroring auth_device_fail.
CREATE OR REPLACE FUNCTION auth_fieldpin_fail(
  p_employee uuid, p_threshold int, p_lockout_secs int)
RETURNS TABLE(failed_count int, locked_until timestamptz, just_locked boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_company uuid; v_cnt int; v_lock timestamptz; v_just boolean := false;
BEGIN
  UPDATE field_pin SET failed_count = failed_count + 1
   WHERE employee_id = p_employee
   RETURNING company_id, field_pin.failed_count, field_pin.locked_until
        INTO v_company, v_cnt, v_lock;
  IF v_cnt >= p_threshold AND (v_lock IS NULL OR v_lock <= now()) THEN
    v_lock := now() + make_interval(secs => p_lockout_secs);
    UPDATE field_pin SET locked_until = v_lock WHERE employee_id = p_employee;
    v_just := true;
    PERFORM audit_append(v_company, p_employee::text, NULL, 'auth.kiosk.lockout',
            'employee', p_employee::text, NULL,
            jsonb_build_object('failed_count', v_cnt, 'locked_until', v_lock));
  END IF;
  RETURN QUERY SELECT v_cnt, v_lock, v_just;
END $$;
GRANT EXECUTE ON FUNCTION auth_fieldpin_fail(uuid, int, int) TO hcmos_app;

-- Mint the SINGLE-USE kiosk session (kind='kiosk', bound to device + person);
-- resets the person's failure count and audits the sign-in.
CREATE OR REPLACE FUNCTION auth_kiosk_success(
  p_device uuid, p_employee uuid, p_token_hash text, p_ttl_secs int)
RETURNS TABLE(session_id uuid, company_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company uuid; v_sid uuid; v_exp timestamptz;
BEGIN
  SELECT d.company_id INTO v_company FROM device d WHERE d.id = p_device;
  UPDATE field_pin SET failed_count = 0 WHERE employee_id = p_employee;
  v_exp := now() + make_interval(secs => p_ttl_secs);
  INSERT INTO session(company_id, user_id, device_id, role_code, token_hash,
                      expires_at, kind, employee_id)
  VALUES (v_company, NULL, p_device, 'R13', p_token_hash, v_exp, 'kiosk', p_employee)
  RETURNING id INTO v_sid;
  PERFORM audit_append(v_company, p_employee::text, 'R13', 'auth.kiosk',
          'session', v_sid::text, NULL,
          jsonb_build_object('device', p_device, 'kind', 'kiosk'));
  RETURN QUERY SELECT v_sid, v_company, v_exp;
END $$;
GRANT EXECUTE ON FUNCTION auth_kiosk_success(uuid, uuid, text, int) TO hcmos_app;

-- AUTO-LOGOUT: revoke one session (called the instant a kiosk punch commits).
CREATE OR REPLACE FUNCTION auth_revoke_session(p_session uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE session SET revoked_at = now() WHERE id = p_session AND revoked_at IS NULL
$$;
GRANT EXECUTE ON FUNCTION auth_revoke_session(uuid) TO hcmos_app;

-- 6. auth_lookup_session now surfaces kind + employee_id (return-type change →
--    DROP + recreate + re-grant), and a KIOSK session additionally requires
--    the punched EMPLOYEE to still be active (same E14 discipline as 039).
DROP FUNCTION IF EXISTS auth_lookup_session(text);
CREATE FUNCTION auth_lookup_session(p_token_hash text)
RETURNS TABLE(session_id uuid, company_id uuid, user_id uuid, device_id uuid,
              role_code text, expires_at timestamptz, kind text, employee_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.company_id, s.user_id, s.device_id, s.role_code, s.expires_at,
         s.kind, s.employee_id
    FROM session s
    JOIN tenant t ON t.company_id = s.company_id
    LEFT JOIN app_user u ON u.id = s.user_id
    LEFT JOIN device dv ON dv.id = s.device_id
    LEFT JOIN employee de ON de.id = dv.employee_id
    LEFT JOIN employee ke ON ke.id = s.employee_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND t.status = 'active'
     AND (u.id IS NULL OR u.status = 'active')
     AND (s.device_id IS NULL OR (dv.status = 'active'
          AND (dv.employee_id IS NULL OR de.status = 'active')))
     AND (s.employee_id IS NULL OR ke.status = 'active')
$$;
GRANT EXECUTE ON FUNCTION auth_lookup_session(text) TO hcmos_app;
