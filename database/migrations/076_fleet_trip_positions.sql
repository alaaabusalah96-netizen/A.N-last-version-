-- Migration 076: fleet phase (e): GPS positions recorded by a driver during a trip.
-- Additive only: one new table. Nothing existing is changed. Rows are write-once and never deleted.
CREATE TABLE IF NOT EXISTS fleet_trip_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  trip_id UUID NOT NULL,
  driver_id UUID NOT NULL,
  latitude NUMERIC(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude NUMERIC(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m NUMERIC(8,1) NULL CHECK (accuracy_m IS NULL OR (accuracy_m >= 0 AND accuracy_m <= 5000)),
  recorded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_fleet_trip_positions_trip FOREIGN KEY (company_id, trip_id) REFERENCES fleet_trips (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fleet_trip_positions_driver FOREIGN KEY (company_id, driver_id) REFERENCES fleet_drivers (company_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_fleet_trip_positions_trip ON fleet_trip_positions (company_id, trip_id, created_at);

DO $do$
DECLARE t TEXT := 'fleet_trip_positions';
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
  EXECUTE format($p$CREATE POLICY %I ON %I TO an_app
    USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)$p$, t || '_tenant_isolation', t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, anon, authenticated', t);
  GRANT SELECT, INSERT, UPDATE ON fleet_trip_positions TO an_app;
  CREATE OR REPLACE FUNCTION fleet_trip_positions_immutable() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION 'fleet_trip_positions rows are write-once and never deleted'; END; $f$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_fleet_trip_positions_no_update ON fleet_trip_positions;
  CREATE TRIGGER trg_fleet_trip_positions_no_update BEFORE UPDATE ON fleet_trip_positions FOR EACH ROW EXECUTE FUNCTION fleet_trip_positions_immutable();
  DROP TRIGGER IF EXISTS trg_fleet_trip_positions_no_delete ON fleet_trip_positions;
  CREATE TRIGGER trg_fleet_trip_positions_no_delete BEFORE DELETE ON fleet_trip_positions FOR EACH ROW EXECUTE FUNCTION fleet_trip_positions_immutable();
END
$do$;
