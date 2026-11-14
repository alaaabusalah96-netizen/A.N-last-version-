-- Migration 041: Supplier Invoices & Accounts Payable (AN-PURCH-INVOICE-1)
-- Tenant-scoped tables with Row Level Security (RLS) for role an_app

-- 1. Ensure composite unique constraint on accounts (for FK reference)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'accounts' AND constraint_type = 'UNIQUE' AND constraint_name = 'uq_accounts_id_company'
  ) THEN
    ALTER TABLE accounts ADD CONSTRAINT uq_accounts_id_company UNIQUE (id, company_id);
  END IF;
END $$;

-- 2. Ensure composite unique constraint on purch_suppliers (for FK reference)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'purch_suppliers' AND constraint_type = 'UNIQUE' AND constraint_name = 'uq_purch_suppliers_id_company'
  ) THEN
    ALTER TABLE purch_suppliers ADD CONSTRAINT uq_purch_suppliers_id_company UNIQUE (id, company_id);
  END IF;
END $$;

-- 3. Ensure composite unique constraint on purch_grn_lines (for FK reference)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'purch_grn_lines' AND constraint_type = 'UNIQUE' AND constraint_name = 'uq_purch_grn_lines_id_company'
  ) THEN
    ALTER TABLE purch_grn_lines ADD CONSTRAINT uq_purch_grn_lines_id_company UNIQUE (id, company_id);
  END IF;
END $$;

-- 4. Alter company_settings to add accounts_payable_account_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'company_settings' AND column_name = 'accounts_payable_account_id'
  ) THEN
    ALTER TABLE company_settings
      ADD COLUMN accounts_payable_account_id UUID NULL,
      ADD CONSTRAINT fk_company_settings_ap_account
        FOREIGN KEY (accounts_payable_account_id, company_id)
        REFERENCES accounts(id, company_id)
        ON DELETE SET NULL;
  END IF;
END $$;

-- 5. Supplier Invoices Header Table
CREATE TABLE IF NOT EXISTS purch_supplier_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  invoice_no VARCHAR(50) NULL,
  supplier_invoice_no VARCHAR(100) NOT NULL,
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NULL,
  memo TEXT NULL,
  journal_entry_id UUID NULL,
  posted_at TIMESTAMPTZ NULL,
  posted_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_purch_supplier_invoices_company_id UNIQUE (company_id, id),
  CONSTRAINT uq_purch_supplier_invoices_supplier_invoice_no UNIQUE (company_id, supplier_id, supplier_invoice_no),
  CONSTRAINT fk_purch_supplier_invoices_supplier
    FOREIGN KEY (supplier_id, company_id)
    REFERENCES purch_suppliers (id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_purch_supplier_invoices_company
  ON purch_supplier_invoices(company_id, created_at DESC);

-- 6. Supplier Invoice Lines Table
CREATE TABLE IF NOT EXISTS purch_supplier_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  grn_line_id UUID NOT NULL,
  item_id UUID NOT NULL,
  qty NUMERIC(15, 4) NOT NULL CHECK (qty > 0),
  unit_cost NUMERIC(15, 4) NOT NULL CHECK (unit_cost >= 0),
  line_no INT NOT NULL DEFAULT 1,
  CONSTRAINT uq_purch_supplier_invoice_lines_id UNIQUE (company_id, id),
  CONSTRAINT fk_purch_supplier_invoice_lines_invoice
    FOREIGN KEY (invoice_id, company_id)
    REFERENCES purch_supplier_invoices (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_purch_supplier_invoice_lines_grn_line
    FOREIGN KEY (grn_line_id, company_id)
    REFERENCES purch_grn_lines (id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_purch_supplier_invoice_lines_invoice
  ON purch_supplier_invoice_lines(invoice_id);

CREATE INDEX IF NOT EXISTS idx_purch_supplier_invoice_lines_grn_line
  ON purch_supplier_invoice_lines(grn_line_id);

-- 7. Enable and Force Row Level Security (RLS)
ALTER TABLE purch_supplier_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE purch_supplier_invoices FORCE ROW LEVEL SECURITY;

ALTER TABLE purch_supplier_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purch_supplier_invoice_lines FORCE ROW LEVEL SECURITY;

-- 8. Tenant Isolation Policies for role an_app
DROP POLICY IF EXISTS purch_supplier_invoices_tenant_isolation ON purch_supplier_invoices;
CREATE POLICY purch_supplier_invoices_tenant_isolation ON purch_supplier_invoices
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS purch_supplier_invoice_lines_tenant_isolation ON purch_supplier_invoice_lines;
CREATE POLICY purch_supplier_invoice_lines_tenant_isolation ON purch_supplier_invoice_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 9. Grant privileges to application role an_app
GRANT SELECT, INSERT, UPDATE, DELETE ON purch_supplier_invoices TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purch_supplier_invoice_lines TO an_app;

-- 10. Revoke untrusted public/anon/authenticated grants
REVOKE ALL ON purch_supplier_invoices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purch_supplier_invoice_lines FROM PUBLIC, anon, authenticated;

-- 11. Seed Config Definition for accounting.purchase_invoice_mapping
INSERT INTO config_definitions (key, domain, label_ar, schema, default_value, description, is_system)
VALUES (
  'accounting.purchase_invoice_mapping',
  'accounting',
  'ربط فواتير المشتريات المحاسبي',
  '{"type":"object","additionalProperties":false,"properties":{"purchases_clearing_account_id":{"type":"string"},"accounts_payable_account_id":{"type":"string"}},"required":["purchases_clearing_account_id","accounts_payable_account_id"]}'::jsonb,
  '{"purchases_clearing_account_id":"","accounts_payable_account_id":""}'::jsonb,
  'Mapping of the Supplier Purchase Invoice posting event to GL accounts (clearing / AP).',
  true
)
ON CONFLICT (key) DO NOTHING;
