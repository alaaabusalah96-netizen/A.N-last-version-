-- Migration 045: Sales Revenue Cycle (AN-SALES-CYCLE-1)
-- Integrates:
-- 1) Customers catalog (sales_customers)
-- 2) Sales Delivery Notes & Goods Issue (sales_delivery_notes, sales_delivery_lines) with inventory decrement
-- 3) Sales Invoices (sales_invoices, sales_invoice_lines) with balanced GL posting (AR / Sales Revenue)
-- 4) Customer Collections (sales_collections) with cash register allocation & GL posting
-- 5) RLS, table ownership, triggers, and company settings integration

-- 1. Extend inv_stock_movements movement_type check to include 'sales_delivery'
ALTER TABLE inv_stock_movements DROP CONSTRAINT IF EXISTS inv_stock_movements_movement_type_check;
ALTER TABLE inv_stock_movements
  ADD CONSTRAINT inv_stock_movements_movement_type_check
  CHECK (movement_type IN ('receive', 'issue', 'transfer_out', 'transfer_in', 'transfer', 'purchase_return', 'sales_delivery'));

-- 2. Alter company_settings to support AR & Sales Revenue accounts
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'company_settings' AND column_name = 'accounts_receivable_account_id'
  ) THEN
    ALTER TABLE company_settings
      ADD COLUMN accounts_receivable_account_id UUID NULL,
      ADD CONSTRAINT fk_company_settings_ar_account
        FOREIGN KEY (accounts_receivable_account_id, company_id)
        REFERENCES accounts(id, company_id)
        ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'company_settings' AND column_name = 'sales_revenue_account_id'
  ) THEN
    ALTER TABLE company_settings
      ADD COLUMN sales_revenue_account_id UUID NULL,
      ADD CONSTRAINT fk_company_settings_sales_rev_account
        FOREIGN KEY (sales_revenue_account_id, company_id)
        REFERENCES accounts(id, company_id)
        ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Customers Master Table
CREATE TABLE IF NOT EXISTS sales_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,
  name_ar VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(255) NULL,
  tax_number VARCHAR(50) NULL,
  address TEXT NULL,
  credit_limit NUMERIC(15, 4) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sales_customers_company_code UNIQUE (company_id, code),
  CONSTRAINT uq_sales_customers_company_id UNIQUE (company_id, id)
);

CREATE INDEX IF NOT EXISTS idx_sales_customers_company ON sales_customers(company_id, name_ar);

-- 4. Sales Delivery Notes Header Table (Goods Issue)
CREATE TABLE IF NOT EXISTS sales_delivery_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  delivery_no VARCHAR(50) NULL,
  delivery_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  memo TEXT NULL,
  posted_at TIMESTAMPTZ NULL,
  posted_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sales_delivery_notes_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_sales_delivery_notes_customer
    FOREIGN KEY (customer_id, company_id)
    REFERENCES sales_customers(id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_sales_delivery_notes_warehouse
    FOREIGN KEY (warehouse_id, company_id)
    REFERENCES inv_warehouses(id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_sales_delivery_notes_company ON sales_delivery_notes(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_delivery_notes_customer ON sales_delivery_notes(customer_id);

-- 5. Sales Delivery Lines Table
CREATE TABLE IF NOT EXISTS sales_delivery_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id UUID NOT NULL,
  qty NUMERIC(15, 4) NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  unit_cost NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  line_no INT NOT NULL DEFAULT 1,
  CONSTRAINT uq_sales_delivery_lines_id UNIQUE (company_id, id),
  CONSTRAINT fk_sales_delivery_lines_delivery
    FOREIGN KEY (delivery_id, company_id)
    REFERENCES sales_delivery_notes(id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_sales_delivery_lines_item
    FOREIGN KEY (item_id, company_id)
    REFERENCES inv_items(id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_sales_delivery_lines_delivery ON sales_delivery_lines(delivery_id);

-- 6. Sales Invoices Header Table (AR Invoices)
CREATE TABLE IF NOT EXISTS sales_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL,
  delivery_id UUID NULL,
  invoice_no VARCHAR(50) NULL,
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  subtotal NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_amount NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  memo TEXT NULL,
  journal_entry_id UUID NULL,
  posted_at TIMESTAMPTZ NULL,
  posted_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sales_invoices_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_sales_invoices_customer
    FOREIGN KEY (customer_id, company_id)
    REFERENCES sales_customers(id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_sales_invoices_delivery
    FOREIGN KEY (delivery_id, company_id)
    REFERENCES sales_delivery_notes(id, company_id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_invoices_company ON sales_invoices(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_customer ON sales_invoices(customer_id);

-- 7. Sales Invoice Lines Table
CREATE TABLE IF NOT EXISTS sales_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id UUID NOT NULL,
  delivery_line_id UUID NULL,
  qty NUMERIC(15, 4) NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(15, 4) NOT NULL CHECK (unit_price >= 0),
  tax_rate NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
  tax_amount NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  line_total NUMERIC(15, 4) NOT NULL CHECK (line_total >= 0),
  line_no INT NOT NULL DEFAULT 1,
  CONSTRAINT uq_sales_invoice_lines_id UNIQUE (company_id, id),
  CONSTRAINT fk_sales_invoice_lines_invoice
    FOREIGN KEY (invoice_id, company_id)
    REFERENCES sales_invoices(id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_sales_invoice_lines_item
    FOREIGN KEY (item_id, company_id)
    REFERENCES inv_items(id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_sales_invoice_lines_delivery_line
    FOREIGN KEY (delivery_line_id, company_id)
    REFERENCES sales_delivery_lines(id, company_id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_invoice_lines_invoice ON sales_invoice_lines(invoice_id);

-- 8. Customer Cash Collections Table (Collections into Cash Registers)
CREATE TABLE IF NOT EXISTS sales_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  register_id UUID NOT NULL,
  collection_no VARCHAR(50) NULL,
  collection_date DATE NOT NULL DEFAULT CURRENT_DATE,
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
  CONSTRAINT uq_sales_collections_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_sales_collections_customer
    FOREIGN KEY (customer_id, company_id)
    REFERENCES sales_customers(id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_sales_collections_invoice
    FOREIGN KEY (invoice_id, company_id)
    REFERENCES sales_invoices(id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_sales_collections_register
    FOREIGN KEY (register_id, company_id)
    REFERENCES cash_registers(id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_sales_collections_company ON sales_collections(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_collections_invoice ON sales_collections(invoice_id);

-- 9. Trigger guards: Prevent modifying lines of posted delivery notes or posted invoices
CREATE OR REPLACE FUNCTION trg_fn_sales_delivery_lines_posted_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status VARCHAR(20);
BEGIN
  SELECT status INTO v_status
  FROM sales_delivery_notes
  WHERE company_id = NEW.company_id AND id = NEW.delivery_id;

  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_SALES_DELIVERY_LINES: Cannot insert or update lines of posted sales delivery note %.', NEW.delivery_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_delivery_lines_posted_guard ON sales_delivery_lines;
CREATE TRIGGER trg_sales_delivery_lines_posted_guard
  BEFORE INSERT OR UPDATE ON sales_delivery_lines
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_sales_delivery_lines_posted_guard();

CREATE OR REPLACE FUNCTION trg_fn_sales_invoice_lines_posted_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status VARCHAR(20);
BEGIN
  SELECT status INTO v_status
  FROM sales_invoices
  WHERE company_id = NEW.company_id AND id = NEW.invoice_id;

  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_SALES_INVOICE_LINES: Cannot insert or update lines of posted sales invoice %.', NEW.invoice_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_invoice_lines_posted_guard ON sales_invoice_lines;
CREATE TRIGGER trg_sales_invoice_lines_posted_guard
  BEFORE INSERT OR UPDATE ON sales_invoice_lines
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_sales_invoice_lines_posted_guard();

-- 10. Enable and Force RLS on all sales tables
ALTER TABLE sales_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_customers FORCE ROW LEVEL SECURITY;

ALTER TABLE sales_delivery_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_delivery_notes FORCE ROW LEVEL SECURITY;

ALTER TABLE sales_delivery_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_delivery_lines FORCE ROW LEVEL SECURITY;

ALTER TABLE sales_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoices FORCE ROW LEVEL SECURITY;

ALTER TABLE sales_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoice_lines FORCE ROW LEVEL SECURITY;

ALTER TABLE sales_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_collections FORCE ROW LEVEL SECURITY;

-- 11. Tenant isolation policies for application role an_app
DROP POLICY IF EXISTS sales_customers_tenant_isolation ON sales_customers;
CREATE POLICY sales_customers_tenant_isolation ON sales_customers
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS sales_delivery_notes_tenant_isolation ON sales_delivery_notes;
CREATE POLICY sales_delivery_notes_tenant_isolation ON sales_delivery_notes
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS sales_delivery_lines_tenant_isolation ON sales_delivery_lines;
CREATE POLICY sales_delivery_lines_tenant_isolation ON sales_delivery_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS sales_invoices_tenant_isolation ON sales_invoices;
CREATE POLICY sales_invoices_tenant_isolation ON sales_invoices
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS sales_invoice_lines_tenant_isolation ON sales_invoice_lines;
CREATE POLICY sales_invoice_lines_tenant_isolation ON sales_invoice_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS sales_collections_tenant_isolation ON sales_collections;
CREATE POLICY sales_collections_tenant_isolation ON sales_collections
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 12. Grants & Revokes
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_customers TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_delivery_notes TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_delivery_lines TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_invoices TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_invoice_lines TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_collections TO an_app;

REVOKE ALL ON sales_customers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON sales_delivery_notes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON sales_delivery_lines FROM PUBLIC, anon, authenticated;
REVOKE ALL ON sales_invoices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON sales_invoice_lines FROM PUBLIC, anon, authenticated;
REVOKE ALL ON sales_collections FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.trg_fn_sales_delivery_lines_posted_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_fn_sales_invoice_lines_posted_guard() FROM PUBLIC, anon, authenticated;
