-- Migration 036: Purchasing Purchase Orders (Headers & Lines)
-- Tenant-scoped tables with Row Level Security (RLS) for role an_app

-- 1. Purchase Orders Header Table
CREATE TABLE IF NOT EXISTS purch_purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'closed', 'cancelled')),
  po_no VARCHAR(50) NULL,
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_date DATE NULL,
  memo TEXT NULL,
  approved_at TIMESTAMPTZ NULL,
  approved_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ NULL,
  closed_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_purch_purchase_orders_company_id_id UNIQUE (company_id, id),
  CONSTRAINT fk_purch_purchase_orders_supplier_company
    FOREIGN KEY (supplier_id, company_id)
    REFERENCES purch_suppliers (id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_purch_purchase_orders_company
  ON purch_purchase_orders(company_id, created_at DESC);

-- 2. Purchase Order Lines Table
CREATE TABLE IF NOT EXISTS purch_po_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id UUID NOT NULL,
  qty NUMERIC(15, 4) NOT NULL CHECK (qty > 0),
  unit_cost NUMERIC(15, 4) NULL,
  received_qty NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (received_qty >= 0 AND received_qty <= qty),
  line_no INT NOT NULL DEFAULT 1,
  CONSTRAINT fk_purch_po_lines_po_company
    FOREIGN KEY (po_id, company_id)
    REFERENCES purch_purchase_orders (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_purch_po_lines_item_company
    FOREIGN KEY (item_id, company_id)
    REFERENCES inv_items (id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_purch_po_lines_po
  ON purch_po_lines(po_id);

CREATE INDEX IF NOT EXISTS idx_purch_po_lines_company
  ON purch_po_lines(company_id, item_id);

-- 3. Enable and Force Row Level Security (RLS)
ALTER TABLE purch_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purch_purchase_orders FORCE ROW LEVEL SECURITY;

ALTER TABLE purch_po_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purch_po_lines FORCE ROW LEVEL SECURITY;

-- 4. Tenant Isolation Policies for role an_app
DROP POLICY IF EXISTS purch_purchase_orders_tenant_isolation ON purch_purchase_orders;
CREATE POLICY purch_purchase_orders_tenant_isolation ON purch_purchase_orders
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS purch_po_lines_tenant_isolation ON purch_po_lines;
CREATE POLICY purch_po_lines_tenant_isolation ON purch_po_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 5. Grant privileges to application role an_app
GRANT SELECT, INSERT, UPDATE, DELETE ON purch_purchase_orders TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purch_po_lines TO an_app;

-- 6. Revoke untrusted public/anon/authenticated grants
REVOKE ALL ON purch_purchase_orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purch_po_lines FROM PUBLIC, anon, authenticated;
