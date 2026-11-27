-- Migration 074: fleet module phase (c1): expenses and the accounting link (AN-ERP fleet design)
-- Additive only: two new tables, nothing existing is changed. Tenant RLS like every company table.
-- Categories map to a per-company expense account (no hard-coded accounts). Expenses are never deleted:
-- draft -> approved -> posted (journal entry) or rejected; a posted expense is cancelled only by a reversing entry (status reversed).
CREATE TABLE IF NOT EXISTS fleet_expense_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  code VARCHAR(30) NOT NULL,
  name_ar VARCHAR(100) NOT NULL,
  expense_account_id UUID NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fleet_expense_categories_company_code UNIQUE (company_id, code),
  CONSTRAINT uq_fleet_expense_categories_company_id_id UNIQUE (company_id, id),
  CONSTRAINT fk_fleet_expense_categories_account FOREIGN KEY (company_id, expense_account_id) REFERENCES accounts (company_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS fleet_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq > 0),
  expense_no VARCHAR(20) NOT NULL,
  org_unit_id UUID NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  vehicle_id UUID NOT NULL,
  trip_id UUID NULL,
  category_id UUID NOT NULL,
  expense_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  description VARCHAR(300) NOT NULL,
  reference_no VARCHAR(60) NULL,
  odometer_km NUMERIC(12,1) NULL CHECK (odometer_km IS NULL OR odometer_km >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','posted','reversed')),
  created_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  approved_by UUID NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NULL,
  rejected_by UUID NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  rejected_at TIMESTAMPTZ NULL,
  reject_reason VARCHAR(300) NULL,
  posted_by UUID NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  posted_at TIMESTAMPTZ NULL,
  counter_account_id UUID NULL,
  journal_entry_id UUID NULL,
  reversed_by UUID NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  reversed_at TIMESTAMPTZ NULL,
  reverse_reason VARCHAR(300) NULL,
  reversal_entry_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fleet_expenses_company_seq UNIQUE (company_id, seq),
  CONSTRAINT uq_fleet_expenses_company_no UNIQUE (company_id, expense_no),
  CONSTRAINT fk_fleet_expenses_vehicle FOREIGN KEY (company_id, vehicle_id) REFERENCES fleet_vehicles (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fleet_expenses_trip FOREIGN KEY (company_id, trip_id) REFERENCES fleet_trips (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fleet_expenses_category FOREIGN KEY (company_id, category_id) REFERENCES fleet_expense_categories (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fleet_expenses_counter FOREIGN KEY (company_id, counter_account_id) REFERENCES accounts (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fleet_expenses_journal FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fleet_expenses_reversal FOREIGN KEY (company_id, reversal_entry_id) REFERENCES journal_entries (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_fleet_expenses_posted CHECK (status NOT IN ('posted','reversed') OR (journal_entry_id IS NOT NULL AND counter_account_id IS NOT NULL AND posted_by IS NOT NULL)),
  CONSTRAINT chk_fleet_expenses_reversed CHECK (status <> 'reversed' OR (reversal_entry_id IS NOT NULL AND reverse_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_fleet_expenses_company_status ON fleet_expenses (company_id, status);
CREATE INDEX IF NOT EXISTS idx_fleet_expenses_vehicle ON fleet_expenses (company_id, vehicle_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_fleet_expenses_trip ON fleet_expenses (company_id, trip_id);

DO $do$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['fleet_expense_categories','fleet_expenses'] LOOP
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
  GRANT SELECT, INSERT, UPDATE ON fleet_expense_categories TO an_app;
  GRANT SELECT, INSERT, UPDATE ON fleet_expenses TO an_app;
  -- Money fields are frozen once an expense leaves draft: the amount, vehicle, category and date cannot change after approval.
  CREATE OR REPLACE FUNCTION fleet_expenses_freeze() RETURNS trigger AS $f$
  BEGIN
    IF OLD.status <> 'draft' AND (NEW.amount <> OLD.amount OR NEW.vehicle_id <> OLD.vehicle_id OR NEW.category_id <> OLD.category_id OR NEW.expense_date <> OLD.expense_date) THEN
      RAISE EXCEPTION 'fleet_expenses: amount, vehicle, category and date are frozen after the draft stage';
    END IF;
    RETURN NEW;
  END; $f$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_fleet_expenses_freeze ON fleet_expenses;
  CREATE TRIGGER trg_fleet_expenses_freeze BEFORE UPDATE ON fleet_expenses FOR EACH ROW EXECUTE FUNCTION fleet_expenses_freeze();
END
$do$;
