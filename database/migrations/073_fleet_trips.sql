-- Migration 073: fleet module phase (b): trips and approval (AN-ERP fleet design)
-- Additive only: two new tables, nothing existing is changed. Tenant RLS like every company table.
-- Trips and their stops are never deleted: a trip ends as completed / cancelled / rejected (a trigger blocks DELETE).
-- Stops are write-once (INSERT only). Approval, dispatch and per-role permissions (fleet:trip:*) are enforced in the application layer.
CREATE TABLE IF NOT EXISTS fleet_trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq > 0),
  trip_no VARCHAR(20) NOT NULL,
  org_unit_id UUID NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  vehicle_id UUID NOT NULL,
  driver_id UUID NOT NULL,
  purpose VARCHAR(200) NOT NULL,
  planned_start TIMESTAMPTZ NOT NULL,
  planned_end TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','dispatched','in_progress','completed','cancelled')),
  requested_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  approved_by UUID NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NULL,
  rejected_by UUID NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  rejected_at TIMESTAMPTZ NULL,
  reject_reason VARCHAR(300) NULL,
  dispatched_by UUID NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  dispatched_at TIMESTAMPTZ NULL,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  cancelled_by UUID NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  cancelled_at TIMESTAMPTZ NULL,
  cancel_reason VARCHAR(300) NULL,
  odometer_start NUMERIC(12,1) NULL CHECK (odometer_start IS NULL OR odometer_start >= 0),
  odometer_end NUMERIC(12,1) NULL CHECK (odometer_end IS NULL OR odometer_end >= 0),
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_fleet_trips_window CHECK (planned_end > planned_start),
  CONSTRAINT chk_fleet_trips_odometer CHECK (odometer_end IS NULL OR odometer_start IS NULL OR odometer_end >= odometer_start),
  CONSTRAINT uq_fleet_trips_company_seq UNIQUE (company_id, seq),
  CONSTRAINT uq_fleet_trips_company_no UNIQUE (company_id, trip_no),
  CONSTRAINT uq_fleet_trips_company_id_id UNIQUE (company_id, id),
  CONSTRAINT fk_fleet_trips_vehicle FOREIGN KEY (company_id, vehicle_id) REFERENCES fleet_vehicles (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fleet_trips_driver FOREIGN KEY (company_id, driver_id) REFERENCES fleet_drivers (company_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_fleet_trips_company_status ON fleet_trips (company_id, status);
CREATE INDEX IF NOT EXISTS idx_fleet_trips_vehicle ON fleet_trips (company_id, vehicle_id, planned_start);
CREATE INDEX IF NOT EXISTS idx_fleet_trips_driver ON fleet_trips (company_id, driver_id, planned_start);

CREATE TABLE IF NOT EXISTS fleet_trip_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  trip_id UUID NOT NULL,
  stop_no INTEGER NOT NULL CHECK (stop_no > 0),
  place_name VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fleet_trip_stops_trip_no UNIQUE (trip_id, stop_no),
  CONSTRAINT fk_fleet_trip_stops_trip FOREIGN KEY (company_id, trip_id) REFERENCES fleet_trips (company_id, id) ON DELETE RESTRICT
);

DO $do$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['fleet_trips','fleet_trip_stops'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format($p$CREATE POLICY %I ON %I TO an_app
      USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)$p$, t || '_tenant_isolation', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('CREATE OR REPLACE FUNCTION %I() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION ''%s rows are never deleted''; END; $f$ LANGUAGE plpgsql', t || '_no_delete', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION %I()', 'trg_' || t || '_no_delete', t, t || '_no_delete');
  END LOOP;
  GRANT SELECT, INSERT, UPDATE ON fleet_trips TO an_app;
  GRANT SELECT, INSERT, UPDATE ON fleet_trip_stops TO an_app;
  CREATE OR REPLACE FUNCTION fleet_trip_stops_no_update() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION 'fleet_trip_stops rows are write-once'; END; $f$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_fleet_trip_stops_no_update ON fleet_trip_stops;
  CREATE TRIGGER trg_fleet_trip_stops_no_update BEFORE UPDATE ON fleet_trip_stops FOR EACH ROW EXECUTE FUNCTION fleet_trip_stops_no_update();
END
$do$;
