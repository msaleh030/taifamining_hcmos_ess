-- ===========================================================================
-- 039 — E14 (ESS-2, Kira 2026-07-14): account status gates the FIELD track on
--       the EMPLOYEE record, and live sessions die with it.
-- ===========================================================================
-- The hole: auth_lookup_device never read employee.status. A TERMINATED
-- employee on the no-app_user bootstrap path (user_status NULL) could still
-- PIN-in and clock in on a mine site while their device row stayed active.
-- And auth_lookup_session gated only app_user/device status, so an already
-- minted field session survived the employee's suspension or termination.
--
-- 1. auth_lookup_device now returns employee_status (the DISC-03/LVR-01
--    source of truth). Return type changes → DROP + recreate + re-grant.
DROP FUNCTION IF EXISTS auth_lookup_device(uuid);
CREATE FUNCTION auth_lookup_device(p_device uuid)
RETURNS TABLE(device_id uuid, company_id uuid, employee_id uuid, pin_hash text,
              device_status text, failed_count int, locked_until timestamptz,
              user_id uuid, role_code text, user_status text, company_status text,
              employee_status text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.company_id, d.employee_id, d.pin_hash, d.status,
         d.failed_count, d.locked_until,
         u.id, u.role_code, u.status, t.status, e.status
    FROM device d
    JOIN tenant t ON t.company_id = d.company_id
    LEFT JOIN employee e ON e.id = d.employee_id
    LEFT JOIN LATERAL (
        SELECT id, role_code, status FROM app_user au
         WHERE au.employee_id = d.employee_id
         ORDER BY (status = 'active') DESC, created_at ASC LIMIT 1
    ) u ON true
   WHERE d.id = p_device
$$;
GRANT EXECUTE ON FUNCTION auth_lookup_device(uuid) TO hcmos_app;

-- 2. auth_lookup_session: a device-bound (field) session additionally requires
--    the device's EMPLOYEE to be active — suspending or terminating the worker
--    kills their live field session immediately, not at token expiry.
--    (Extends migration 022 / bughunt M1; console sessions are unchanged —
--    they are already gated on app_user status.)
CREATE OR REPLACE FUNCTION auth_lookup_session(p_token_hash text)
RETURNS TABLE(session_id uuid, company_id uuid, user_id uuid, device_id uuid,
              role_code text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.company_id, s.user_id, s.device_id, s.role_code, s.expires_at
    FROM session s
    JOIN tenant t ON t.company_id = s.company_id
    LEFT JOIN app_user u ON u.id = s.user_id
    LEFT JOIN device dv ON dv.id = s.device_id
    LEFT JOIN employee de ON de.id = dv.employee_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND t.status = 'active'
     AND (u.id IS NULL OR u.status = 'active')
     AND (s.device_id IS NULL OR (dv.status = 'active'
          AND (dv.employee_id IS NULL OR de.status = 'active')))
$$;
