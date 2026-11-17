-- Migration 049: Production-Grade Inventory Valuation Engine (FIFO & Perpetual Moving Average)
-- Implements complete valuation subledger, cost layers, cost allocations, opening valuation,
-- price variance adjustments, and RLS/tenant security policies for role an_app.

-- 1. Costing Profiles Master Table
CREATE TABLE IF NOT EXISTS inv_costing_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  costing_method VARCHAR(50) NOT NULL CHECK (costing_method IN ('FIFO', 'PERPETUAL_MOVING_AVERAGE')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inv_costing_profiles_company_name UNIQUE (company_id, name),
  CONSTRAINT uq_inv_costing_profiles_id_company UNIQUE (id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_inv_costing_profiles_company ON inv_costing_profiles(company_id);

-- 2. Item Costing Assignments Table
CREATE TABLE IF NOT EXISTS inv_item_costing_profiles (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id UUID NOT NULL,
  profile_id UUID NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  PRIMARY KEY (company_id, item_id),
  CONSTRAINT fk_inv_item_cp_item FOREIGN KEY (item_id, company_id) REFERENCES inv_items (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_item_cp_profile FOREIGN KEY (profile_id, company_id) REFERENCES inv_costing_profiles (id, company_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inv_item_cp_company ON inv_item_costing_profiles(company_id);

-- 3. Valuation Balances Table (by warehouse and item)
CREATE TABLE IF NOT EXISTS inv_valuation_balances (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL,
  item_id UUID NOT NULL,
  quantity NUMERIC(15, 4) NOT NULL DEFAULT 0.0000 CHECK (quantity >= 0),
  total_cost NUMERIC(15, 4) NOT NULL DEFAULT 0.0000 CHECK (total_cost >= 0),
  unit_cost NUMERIC(15, 4) NOT NULL DEFAULT 0.0000 CHECK (unit_cost >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, warehouse_id, item_id),
  CONSTRAINT fk_inv_val_bal_wh FOREIGN KEY (warehouse_id, company_id) REFERENCES inv_warehouses (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_val_bal_item FOREIGN KEY (item_id, company_id) REFERENCES inv_items (id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inv_valuation_balances_wh ON inv_valuation_balances(company_id, warehouse_id, item_id);

-- 4. FIFO Cost Layers Table
CREATE TABLE IF NOT EXISTS inv_cost_layers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL,
  item_id UUID NOT NULL,
  original_qty NUMERIC(15, 4) NOT NULL CHECK (original_qty > 0),
  remaining_qty NUMERIC(15, 4) NOT NULL CHECK (remaining_qty >= 0),
  unit_cost NUMERIC(15, 4) NOT NULL CHECK (unit_cost >= 0),
  total_cost NUMERIC(15, 4) NOT NULL CHECK (total_cost >= 0),
  source_type VARCHAR(50) NOT NULL,
  source_id UUID NOT NULL,
  source_line_id UUID NULL,
  effective_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_exhausted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inv_cost_layers_id_company UNIQUE (id, company_id),
  CONSTRAINT fk_inv_layers_wh FOREIGN KEY (warehouse_id, company_id) REFERENCES inv_warehouses (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_layers_item FOREIGN KEY (item_id, company_id) REFERENCES inv_items (id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inv_cost_layers_active ON inv_cost_layers(company_id, warehouse_id, item_id, effective_date, created_at) WHERE remaining_qty > 0;

-- 5. Valuation Movements Ledger Table
CREATE TABLE IF NOT EXISTS inv_valuation_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL,
  item_id UUID NOT NULL,
  movement_type VARCHAR(50) NOT NULL CHECK (movement_type IN ('RECEIVE', 'ISSUE', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'OPENING', 'RETURN')),
  qty NUMERIC(15, 4) NOT NULL CHECK (qty > 0),
  unit_cost NUMERIC(15, 4) NOT NULL CHECK (unit_cost >= 0),
  total_cost NUMERIC(15, 4) NOT NULL CHECK (total_cost >= 0),
  source_type VARCHAR(50) NOT NULL,
  source_id UUID NOT NULL,
  source_line_id UUID NULL,
  journal_entry_id UUID NULL REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inv_val_mov_id_company UNIQUE (id, company_id),
  CONSTRAINT fk_inv_val_mov_wh FOREIGN KEY (warehouse_id, company_id) REFERENCES inv_warehouses (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_val_mov_item FOREIGN KEY (item_id, company_id) REFERENCES inv_items (id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inv_val_mov_company ON inv_valuation_movements(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_val_mov_item ON inv_valuation_movements(company_id, warehouse_id, item_id);

-- 6. Cost Allocations Table (linking outgoing movements to FIFO layers)
CREATE TABLE IF NOT EXISTS inv_cost_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  valuation_movement_id UUID NOT NULL,
  cost_layer_id UUID NULL,
  allocated_qty NUMERIC(15, 4) NOT NULL CHECK (allocated_qty > 0),
  unit_cost NUMERIC(15, 4) NOT NULL CHECK (unit_cost >= 0),
  allocated_cost NUMERIC(15, 4) NOT NULL CHECK (allocated_cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_inv_cost_alloc_mov FOREIGN KEY (valuation_movement_id, company_id) REFERENCES inv_valuation_movements (id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inv_cost_alloc_mov ON inv_cost_allocations(company_id, valuation_movement_id);

-- 7. Cost Adjustments Table (for supplier invoice price variance, etc.)
CREATE TABLE IF NOT EXISTS inv_cost_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_type VARCHAR(50) NOT NULL,
  source_id UUID NOT NULL,
  item_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  adjustment_amount NUMERIC(15, 4) NOT NULL,
  remaining_allocation NUMERIC(15, 4) NOT NULL,
  consumed_allocation NUMERIC(15, 4) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'posted',
  journal_entry_id UUID NULL REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_inv_cost_adj_wh FOREIGN KEY (warehouse_id, company_id) REFERENCES inv_warehouses (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_cost_adj_item FOREIGN KEY (item_id, company_id) REFERENCES inv_items (id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inv_cost_adj_company ON inv_cost_adjustments(company_id, created_at DESC);

-- 8. Opening Valuations Table
CREATE TABLE IF NOT EXISTS inv_opening_valuations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL,
  item_id UUID NOT NULL,
  quantity NUMERIC(15, 4) NOT NULL CHECK (quantity > 0),
  total_cost NUMERIC(15, 4) NOT NULL CHECK (total_cost >= 0),
  unit_cost NUMERIC(15, 4) NOT NULL CHECK (unit_cost >= 0),
  status VARCHAR(30) NOT NULL DEFAULT 'pending_setup' CHECK (status IN ('pending_setup', 'approved', 'rejected')),
  approved_at TIMESTAMPTZ NULL,
  approved_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  journal_entry_id UUID NULL REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_inv_opening_wh FOREIGN KEY (warehouse_id, company_id) REFERENCES inv_warehouses (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_opening_item FOREIGN KEY (item_id, company_id) REFERENCES inv_items (id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inv_opening_company ON inv_opening_valuations(company_id, created_at DESC);

-- 9. Valuation Reconciliations Table
CREATE TABLE IF NOT EXISTS inv_valuation_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse_id UUID NULL,
  period_id UUID NULL REFERENCES accounting_periods(id) ON DELETE SET NULL,
  subledger_total NUMERIC(15, 4) NOT NULL,
  gl_control_total NUMERIC(15, 4) NOT NULL,
  variance NUMERIC(15, 4) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'reconciled',
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  CONSTRAINT fk_inv_val_rec_wh FOREIGN KEY (warehouse_id, company_id) REFERENCES inv_warehouses (id, company_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_inv_val_rec_company ON inv_valuation_reconciliations(company_id, reconciled_at DESC);

-- 10. Enable and Force Row Level Security (RLS)
ALTER TABLE inv_costing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_costing_profiles FORCE ROW LEVEL SECURITY;

ALTER TABLE inv_item_costing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_item_costing_profiles FORCE ROW LEVEL SECURITY;

ALTER TABLE inv_valuation_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_valuation_balances FORCE ROW LEVEL SECURITY;

ALTER TABLE inv_cost_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_cost_layers FORCE ROW LEVEL SECURITY;

ALTER TABLE inv_valuation_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_valuation_movements FORCE ROW LEVEL SECURITY;

ALTER TABLE inv_cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_cost_allocations FORCE ROW LEVEL SECURITY;

ALTER TABLE inv_cost_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_cost_adjustments FORCE ROW LEVEL SECURITY;

ALTER TABLE inv_opening_valuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_opening_valuations FORCE ROW LEVEL SECURITY;

ALTER TABLE inv_valuation_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_valuation_reconciliations FORCE ROW LEVEL SECURITY;

-- 11. Tenant Isolation Policies for role an_app
DROP POLICY IF EXISTS inv_costing_profiles_tenant_isolation ON inv_costing_profiles;
CREATE POLICY inv_costing_profiles_tenant_isolation ON inv_costing_profiles
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS inv_item_costing_profiles_tenant_isolation ON inv_item_costing_profiles;
CREATE POLICY inv_item_costing_profiles_tenant_isolation ON inv_item_costing_profiles
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS inv_valuation_balances_tenant_isolation ON inv_valuation_balances;
CREATE POLICY inv_valuation_balances_tenant_isolation ON inv_valuation_balances
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS inv_cost_layers_tenant_isolation ON inv_cost_layers;
CREATE POLICY inv_cost_layers_tenant_isolation ON inv_cost_layers
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS inv_valuation_movements_tenant_isolation ON inv_valuation_movements;
CREATE POLICY inv_valuation_movements_tenant_isolation ON inv_valuation_movements
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS inv_cost_allocations_tenant_isolation ON inv_cost_allocations;
CREATE POLICY inv_cost_allocations_tenant_isolation ON inv_cost_allocations
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS inv_cost_adjustments_tenant_isolation ON inv_cost_adjustments;
CREATE POLICY inv_cost_adjustments_tenant_isolation ON inv_cost_adjustments
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS inv_opening_valuations_tenant_isolation ON inv_opening_valuations;
CREATE POLICY inv_opening_valuations_tenant_isolation ON inv_opening_valuations
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS inv_valuation_reconciliations_tenant_isolation ON inv_valuation_reconciliations;
CREATE POLICY inv_valuation_reconciliations_tenant_isolation ON inv_valuation_reconciliations
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 12. Grant privileges to application role an_app
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_costing_profiles TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_item_costing_profiles TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_valuation_balances TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_cost_layers TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_valuation_movements TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_cost_allocations TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_cost_adjustments TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_opening_valuations TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_valuation_reconciliations TO an_app;

-- 13. Revoke untrusted public/anon/authenticated grants
REVOKE ALL ON inv_costing_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON inv_item_costing_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON inv_valuation_balances FROM PUBLIC, anon, authenticated;
REVOKE ALL ON inv_cost_layers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON inv_valuation_movements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON inv_cost_allocations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON inv_cost_adjustments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON inv_opening_valuations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON inv_valuation_reconciliations FROM PUBLIC, anon, authenticated;
