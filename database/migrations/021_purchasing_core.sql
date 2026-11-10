-- Migration 021: Purchasing Core (Suppliers, GRN Headers, GRN Lines)
-- Tenant-scoped tables with Row Level Security (RLS) for role an_app

-- 1. Suppliers Table
CREATE TABLE IF NOT EXISTS purch_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,
  name_ar VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_purch_suppliers_company_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_purch_suppliers_company ON purch_suppliers(company_id);

-- 2. Goods Receipt Note (GRN) Header Table
CREATE TABLE IF NOT EXISTS purch_grn (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES purch_suppliers(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES inv_warehouses(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  grn_no VARCHAR(50) NULL,
  posted_at TIMESTAMPTZ NULL,
  posted_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  memo TEXT NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purch_grn_company ON purch_grn(company_id, created_at DESC);

-- 3. GRN Lines Table
CREATE TABLE IF NOT EXISTS purch_grn_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_id UUID NOT NULL REFERENCES purch_grn(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inv_items(id) ON DELETE RESTRICT,
  qty NUMERIC(15, 4) NOT NULL CHECK (qty > 0),
  unit_cost NUMERIC(15, 4) NULL,
  line_no INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_purch_grn_lines_grn ON purch_grn_lines(grn_id);
CREATE INDEX IF NOT EXISTS idx_purch_grn_lines_company ON purch_grn_lines(company_id, item_id);

-- 4. Enable and Force Row Level Security (RLS)
ALTER TABLE purch_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE purch_suppliers FORCE ROW LEVEL SECURITY;

ALTER TABLE purch_grn ENABLE ROW LEVEL SECURITY;
ALTER TABLE purch_grn FORCE ROW LEVEL SECURITY;

ALTER TABLE purch_grn_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purch_grn_lines FORCE ROW LEVEL SECURITY;

-- 5. Tenant Isolation Policies for role an_app
DROP POLICY IF EXISTS purch_suppliers_tenant_isolation ON purch_suppliers;
CREATE POLICY purch_suppliers_tenant_isolation ON purch_suppliers
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS purch_grn_tenant_isolation ON purch_grn;
CREATE POLICY purch_grn_tenant_isolation ON purch_grn
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS purch_grn_lines_tenant_isolation ON purch_grn_lines;
CREATE POLICY purch_grn_lines_tenant_isolation ON purch_grn_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 6. Grant privileges to application role an_app
GRANT SELECT, INSERT, UPDATE, DELETE ON purch_suppliers TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purch_grn TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purch_grn_lines TO an_app;

-- 7. Revoke untrusted public/anon/authenticated grants
REVOKE ALL ON purch_suppliers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purch_grn FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purch_grn_lines FROM PUBLIC, anon, authenticated;
