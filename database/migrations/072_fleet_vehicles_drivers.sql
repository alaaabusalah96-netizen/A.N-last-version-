-- Migration 072: fleet module phase (a): vehicles and drivers (AN-ERP fleet design)
-- Additive only: two new tables, nothing existing is changed. Tenant RLS like every company table.
-- Rows are never deleted: a vehicle or driver is retired / inactive through its status (a trigger blocks DELETE).
-- Orgunit scope and per-role permissions (fleet:read, fleet:manage) are enforced in the application layer.
CREATE TABLE IF NOT EXISTS fleet_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  org_unit_id UUID NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  code VARCHAR(30) NOT NULL,
  plate_no VARCHAR(30) NOT NULL,
  vehicle_type VARCHAR(30) NOT NULL DEFAULT 'car',
  make VARCHAR(60) NULL,
  model VARCHAR(60) NULL,
  model_year INTEGER NULL CHECK (model_year IS NULL OR (model_year >= 1950 AND model_year <= 2100)),
  odometer_km NUMERIC(12,1) NOT NULL DEFAULT 0 CHECK (odometer_km >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','out_of_service','retired')),
  notes TEXT NULL,
  created_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fleet_vehicles_company_code UNIQUE (company_id, code),
  CONSTRAINT uq_fleet_vehicles_company_plate UNIQUE (company_id, plate_no),
  CONSTRAINT uq_fleet_vehicles_company_id_id UNIQUE (company_id, id)
);
CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_company_status ON fleet_vehicles (company_id, status);

CREATE TABLE IF NOT EXISTS fleet_drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  user_id UUID NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  org_unit_id UUID NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  full_name VARCHAR(120) NOT NULL,
  phone VARCHAR(30) NULL,
  license_no VARCHAR(40) NULL,
  license_expiry DATE NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','inactive')),
  created_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fleet_drivers_company_id_id UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fleet_drivers_company_license ON fleet_drivers (company_id, license_no) WHERE license_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fleet_drivers_company_user ON fleet_drivers (company_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fleet_drivers_company_status ON fleet_drivers (company_id, status);

DO $do$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['fleet_vehicles','fleet_drivers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format($p$CREATE POLICY %I ON %I TO an_app
      USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)$p$, t || '_tenant_isolation', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO an_app', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('CREATE OR REPLACE FUNCTION %I() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION ''%s rows are never deleted: change the status instead''; END; $f$ LANGUAGE plpgsql', t || '_no_delete', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION %I()', 'trg_' || t || '_no_delete', t, t || '_no_delete');
  END LOOP;
END
$do$;
