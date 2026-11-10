-- Migration 019: Inventory Core (Warehouses, Items, Stock Balances, Stock Movements)
-- Tenant-scoped tables with Row Level Security (RLS) for role an_app

-- 1. Warehouses Table
CREATE TABLE IF NOT EXISTS inv_warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,
  name_ar VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inv_warehouses_company_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_inv_warehouses_company ON inv_warehouses(company_id);

-- 2. Items Master Table
CREATE TABLE IF NOT EXISTS inv_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,
  name_ar VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NULL,
  uom VARCHAR(50) NOT NULL DEFAULT 'unit',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inv_items_company_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_inv_items_company ON inv_items(company_id);

-- 3. Stock Balances Table
CREATE TABLE IF NOT EXISTS inv_stock_balances (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES inv_warehouses(id) ON DELETE RESTRICT,
  item_id UUID NOT NULL REFERENCES inv_items(id) ON DELETE RESTRICT,
  qty NUMERIC(15, 4) NOT NULL DEFAULT 0.0000 CHECK (qty >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, warehouse_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_inv_stock_balances_wh_item ON inv_stock_balances(company_id, warehouse_id, item_id);

-- 4. Stock Movements Table
CREATE TABLE IF NOT EXISTS inv_stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES inv_warehouses(id) ON DELETE RESTRICT,
  item_id UUID NOT NULL REFERENCES inv_items(id) ON DELETE RESTRICT,
  movement_type VARCHAR(20) NOT NULL CHECK (movement_type IN ('receive', 'issue')),
  qty NUMERIC(15, 4) NOT NULL CHECK (qty > 0),
  memo TEXT NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_stock_movements_company ON inv_stock_movements(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_stock_movements_item ON inv_stock_movements(company_id, warehouse_id, item_id);

-- 5. Enable and Force Row Level Security (RLS)
ALTER TABLE inv_warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_warehouses FORCE ROW LEVEL SECURITY;

ALTER TABLE inv_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_items FORCE ROW LEVEL SECURITY;

ALTER TABLE inv_stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_stock_balances FORCE ROW LEVEL SECURITY;

ALTER TABLE inv_stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_stock_movements FORCE ROW LEVEL SECURITY;

-- 6. Tenant Isolation Policies for role an_app
DROP POLICY IF EXISTS inv_warehouses_tenant_isolation ON inv_warehouses;
CREATE POLICY inv_warehouses_tenant_isolation ON inv_warehouses
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS inv_items_tenant_isolation ON inv_items;
CREATE POLICY inv_items_tenant_isolation ON inv_items
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS inv_stock_balances_tenant_isolation ON inv_stock_balances;
CREATE POLICY inv_stock_balances_tenant_isolation ON inv_stock_balances
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS inv_stock_movements_tenant_isolation ON inv_stock_movements;
CREATE POLICY inv_stock_movements_tenant_isolation ON inv_stock_movements
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 7. Grant privileges to application role an_app
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_warehouses TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_items TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_stock_balances TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_stock_movements TO an_app;

-- 8. Revoke untrusted public/anon/authenticated grants
REVOKE ALL ON inv_warehouses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON inv_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON inv_stock_balances FROM PUBLIC, anon, authenticated;
REVOKE ALL ON inv_stock_movements FROM PUBLIC, anon, authenticated;
