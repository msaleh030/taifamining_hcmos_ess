-- ===========================================================================
-- 006 — Geofence zones (SS-3): MULTIPLE zones per site
-- ===========================================================================
-- A site may have 0..N zones; a clock-in is valid if the server-recomputed
-- location is inside ANY zone mapped to the employee's site. Zones are data
-- (the registry) — never hard-coded. Per zone: centre lat/lng + exact radius (m).
-- Distance is Haversine, computed server-side (src/geofence.js). Additive; RLS
-- isolates by tenant like every other table.

CREATE TABLE IF NOT EXISTS geofence_zone (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES tenant(company_id),
  site_id     uuid NOT NULL REFERENCES site(id),
  name        text NOT NULL,
  center_lat  double precision NOT NULL CHECK (center_lat  BETWEEN -90  AND 90),
  center_lng  double precision NOT NULL CHECK (center_lng BETWEEN -180 AND 180),
  radius_m    numeric(9,1) NOT NULL CHECK (radius_m > 0)
);

CREATE INDEX IF NOT EXISTS geofence_zone_site_idx ON geofence_zone (company_id, site_id);

ALTER TABLE geofence_zone ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON geofence_zone;
CREATE POLICY tenant_isolation ON geofence_zone
  USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- The app re-validates clock-ins by reading zones; zone administration (writes)
-- is a separate concern handled by the owner/admin path.
GRANT SELECT ON geofence_zone TO hcmos_app;
