-- Migration 077: fleet phase (f): vehicle maintenance and document records with next-due tracking.
-- Additive only: one new table. Nothing existing is changed. Rows are never deleted; a wrong record is voided with a reason.
-- Cost here is informational. Accounting stays in fleet_expenses so a cost is never posted twice.
CREATE TABLE IF NOT EXISTS fleet_vehicle_maintenance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  vehicle_id UUID NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('service','repair','inspection','tires','insurance','license','other')),
  performed_on DATE NOT NULL,
  odometer_km NUMERIC(12,1) NULL CHECK (odometer_km IS NULL OR odometer_km >= 0),
  cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  vendor VARCHAR(120) NULL,
  notes TEXT NULL,
  next_due_date DATE NULL,
  next_due_km NUMERIC(12,1) NULL CHECK (next_due_km IS NULL OR next_due_km >= 0),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  void_reason TEXT NULL,
  voided_at TIMESTAMPTZ NULL,
  created_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_fleet_vehicle_maintenance_vehicle FOREIGN KEY (company_id, vehicle_id) REFERENCES fleet_vehicles (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_fleet_vehicle_maintenance_void CHECK ((status = 'active' AND void_reason IS NULL AND voided_at IS NULL) OR (status = 'voided' AND void_reason IS NOT NULL AND voided_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_fleet_vehicle_maintenance_vehicle ON fleet_vehicle_maintenance (company_id, vehicle_id, performed_on DESC);

DO $do$
DECLARE t TEXT := 'fleet_vehicle_maintenance';
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
  EXECUTE format($p$CREATE POLICY %I ON %I TO an_app
    USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)$p$, t || '_tenant_isolation', t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, anon, authenticated', t);
  GRANT SELECT, INSERT, UPDATE ON fleet_vehicle_maintenance TO an_app;
  CREATE OR REPLACE FUNCTION fleet_vehicle_maintenance_guard() RETURNS trigger AS $f$
  BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fleet_vehicle_maintenance rows are never deleted; void them instead'; END IF;
    IF OLD.status <> 'active' OR NEW.status <> 'voided' THEN RAISE EXCEPTION 'only an active maintenance record can be voided'; END IF;
    IF (to_jsonb(NEW) - 'status' - 'void_reason' - 'voided_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'void_reason' - 'voided_at') THEN
      RAISE EXCEPTION 'maintenance records are write-once except for voiding';
    END IF;
    RETURN NEW;
  END; $f$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_fleet_vehicle_maintenance_no_delete ON fleet_vehicle_maintenance;
  CREATE TRIGGER trg_fleet_vehicle_maintenance_no_delete BEFORE DELETE ON fleet_vehicle_maintenance FOR EACH ROW EXECUTE FUNCTION fleet_vehicle_maintenance_guard();
  DROP TRIGGER IF EXISTS trg_fleet_vehicle_maintenance_update_guard ON fleet_vehicle_maintenance;
  CREATE TRIGGER trg_fleet_vehicle_maintenance_update_guard BEFORE UPDATE ON fleet_vehicle_maintenance FOR EACH ROW EXECUTE FUNCTION fleet_vehicle_maintenance_guard();
END
$do$;
