-- ==============================================================================
-- Migration 080: Multi-invoice supplier payments (additive)
-- A supplier payment can allocate to up to 100 supplier invoices (one line per invoice).
-- Header amount = sum(lines); header invoice_id = first line invoice (legacy compat).
-- Existing payments are untouched: no lines rows means legacy single-invoice.
-- Rollback: DROP TABLE purch_supplier_payment_lines; and delete the 080 row from schema_migrations.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS purch_supplier_payment_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no >= 1 AND line_no <= 100),
  invoice_id UUID NOT NULL,
  amount NUMERIC(15,4) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_purch_supplier_payment_lines_no UNIQUE (payment_id, line_no),
  CONSTRAINT uq_purch_supplier_payment_lines_invoice UNIQUE (payment_id, invoice_id),
  CONSTRAINT fk_purch_supplier_payment_lines_payment
    FOREIGN KEY (company_id, payment_id) REFERENCES purch_supplier_payments(company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_purch_supplier_payment_lines_invoice
    FOREIGN KEY (invoice_id, company_id) REFERENCES purch_supplier_invoices(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_purch_supplier_payment_lines_payment ON purch_supplier_payment_lines (company_id, payment_id);
CREATE INDEX IF NOT EXISTS idx_purch_supplier_payment_lines_invoice ON purch_supplier_payment_lines (company_id, invoice_id);

ALTER TABLE purch_supplier_payment_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purch_supplier_payment_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purch_supplier_payment_lines_tenant_isolation ON purch_supplier_payment_lines;
CREATE POLICY purch_supplier_payment_lines_tenant_isolation ON purch_supplier_payment_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON purch_supplier_payment_lines TO an_app;
REVOKE ALL ON purch_supplier_payment_lines FROM PUBLIC, anon, authenticated;
