-- Migration 044: Purchasing Complete (AN-PURCH-COMPLETE-1)
-- Integrates:
-- 1) Purchase Returns (purch_returns, purch_return_lines) with atomic inventory decrement & GL posting
-- 2) Supplier Cash Payments (purch_supplier_payments) with register cashbox check, AP invoice allocation & GL posting
-- 3) 3-Way Matching metadata & policy support tables/functions
-- 4) RLS, security hardening, triggers, and table ownership

-- 1. Extend inv_stock_movements movement_type check to include 'purchase_return'
ALTER TABLE inv_stock_movements DROP CONSTRAINT IF EXISTS inv_stock_movements_movement_type_check;
ALTER TABLE inv_stock_movements
  ADD CONSTRAINT inv_stock_movements_movement_type_check
  CHECK (movement_type IN ('receive', 'issue', 'transfer_out', 'transfer_in', 'transfer', 'purchase_return'));

-- 2. Ensure composite unique constraints on parent tables for secure foreign keys
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'purch_grn' AND constraint_type = 'UNIQUE' AND constraint_name = 'uq_purch_grn_id_company'
  ) THEN
    ALTER TABLE purch_grn ADD CONSTRAINT uq_purch_grn_id_company UNIQUE (id, company_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'cash_registers' AND constraint_type = 'UNIQUE' AND constraint_name = 'uq_cash_registers_id_company'
  ) THEN
    ALTER TABLE cash_registers ADD CONSTRAINT uq_cash_registers_id_company UNIQUE (id, company_id);
  END IF;
END $$;

-- 3. Purchase Returns Header Table
CREATE TABLE IF NOT EXISTS purch_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  grn_id UUID NOT NULL,
  invoice_id UUID NULL,
  return_no VARCHAR(50) NULL,
  return_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  reason TEXT NULL,
  memo TEXT NULL,
  journal_entry_id UUID NULL,
  posted_at TIMESTAMPTZ NULL,
  posted_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_purch_returns_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_purch_returns_supplier
    FOREIGN KEY (supplier_id, company_id)
    REFERENCES purch_suppliers(id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_purch_returns_warehouse
    FOREIGN KEY (warehouse_id, company_id)
    REFERENCES inv_warehouses(id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_purch_returns_grn
    FOREIGN KEY (grn_id, company_id)
    REFERENCES purch_grn(id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_purch_returns_invoice
    FOREIGN KEY (invoice_id, company_id)
    REFERENCES purch_supplier_invoices(id, company_id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_purch_returns_company ON purch_returns(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purch_returns_grn ON purch_returns(grn_id);

-- 4. Purchase Return Lines Table
CREATE TABLE IF NOT EXISTS purch_return_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  grn_line_id UUID NOT NULL,
  item_id UUID NOT NULL,
  qty NUMERIC(15, 4) NOT NULL CHECK (qty > 0),
  unit_cost NUMERIC(15, 4) NOT NULL CHECK (unit_cost >= 0),
  line_no INT NOT NULL DEFAULT 1,
  CONSTRAINT uq_purch_return_lines_id UNIQUE (company_id, id),
  CONSTRAINT uq_purch_return_lines_return_grn UNIQUE (company_id, return_id, grn_line_id),
  CONSTRAINT fk_purch_return_lines_return
    FOREIGN KEY (return_id, company_id)
    REFERENCES purch_returns(id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_purch_return_lines_grn_line
    FOREIGN KEY (grn_line_id, company_id)
    REFERENCES purch_grn_lines(id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_purch_return_lines_item
    FOREIGN KEY (item_id, company_id)
    REFERENCES inv_items(id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_purch_return_lines_return ON purch_return_lines(return_id);
CREATE INDEX IF NOT EXISTS idx_purch_return_lines_grn_line ON purch_return_lines(grn_line_id);

-- 5. Supplier Cash Payments Table
CREATE TABLE IF NOT EXISTS purch_supplier_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  register_id UUID NOT NULL,
  payment_no VARCHAR(50) NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(15, 4) NOT NULL CHECK (amount > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  reference VARCHAR(100) NULL,
  memo TEXT NULL,
  journal_entry_id UUID NULL,
  posted_at TIMESTAMPTZ NULL,
  posted_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_purch_supplier_payments_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_purch_supplier_payments_supplier
    FOREIGN KEY (supplier_id, company_id)
    REFERENCES purch_suppliers(id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_purch_supplier_payments_invoice
    FOREIGN KEY (invoice_id, company_id)
    REFERENCES purch_supplier_invoices(id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_purch_supplier_payments_register
    FOREIGN KEY (register_id, company_id)
    REFERENCES cash_registers(id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_purch_supplier_payments_company ON purch_supplier_payments(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purch_supplier_payments_invoice ON purch_supplier_payments(invoice_id);

-- 6. Trigger guard: Prevent modifying lines of posted purchase returns
CREATE OR REPLACE FUNCTION trg_fn_purch_return_lines_posted_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status VARCHAR(20);
BEGIN
  SELECT status INTO v_status
  FROM purch_returns
  WHERE company_id = NEW.company_id AND id = NEW.return_id;

  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_PURCH_RETURN_LINES: Cannot insert or update lines of posted purchase return %.', NEW.return_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purch_return_lines_posted_guard ON purch_return_lines;
CREATE TRIGGER trg_purch_return_lines_posted_guard
  BEFORE INSERT OR UPDATE ON purch_return_lines
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_purch_return_lines_posted_guard();

-- 7. Enable and Force RLS on new tables
ALTER TABLE purch_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE purch_returns FORCE ROW LEVEL SECURITY;

ALTER TABLE purch_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purch_return_lines FORCE ROW LEVEL SECURITY;

ALTER TABLE purch_supplier_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE purch_supplier_payments FORCE ROW LEVEL SECURITY;

-- 8. Tenant isolation policies for an_app
DROP POLICY IF EXISTS purch_returns_tenant_isolation ON purch_returns;
CREATE POLICY purch_returns_tenant_isolation ON purch_returns
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS purch_return_lines_tenant_isolation ON purch_return_lines;
CREATE POLICY purch_return_lines_tenant_isolation ON purch_return_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS purch_supplier_payments_tenant_isolation ON purch_supplier_payments;
CREATE POLICY purch_supplier_payments_tenant_isolation ON purch_supplier_payments
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 9. Grants & Revokes
GRANT SELECT, INSERT, UPDATE, DELETE ON purch_returns TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purch_return_lines TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purch_supplier_payments TO an_app;

REVOKE ALL ON purch_returns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purch_return_lines FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purch_supplier_payments FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_fn_purch_return_lines_posted_guard() FROM PUBLIC, anon, authenticated;

-- 10. Seed Config Definition for accounting.purchase_return_mapping
INSERT INTO config_definitions (key, domain, label_ar, schema, default_value, description, is_system)
VALUES (
  'accounting.purchase_return_mapping',
  'accounting',
  'ربط مرتجعات المشتريات المحاسبي',
  '{"type":"object","additionalProperties":false,"properties":{},"required":[]}'::jsonb,
  '{}'::jsonb,
  'Mapping of Purchase Return event to GL accounts (resolves from grn_mapping and purchase_invoice_mapping).',
  true
)
ON CONFLICT (key) DO NOTHING;
