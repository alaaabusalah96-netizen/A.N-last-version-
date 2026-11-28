-- ==============================================================================
-- Migration 079: Multi-invoice sales collections (additive)
-- A collection can allocate to up to 100 invoices (one line per invoice).
-- Header amount = sum(lines); header invoice_id = first line invoice (legacy compat).
-- Existing collections are untouched: no lines rows means legacy single-invoice.
-- Rollback: DROP TABLE sales_collection_lines; and delete the 079 row from schema_migrations.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS sales_collection_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  collection_id UUID NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no >= 1 AND line_no <= 100),
  invoice_id UUID NOT NULL,
  amount NUMERIC(15,4) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sales_collection_lines_no UNIQUE (collection_id, line_no),
  CONSTRAINT uq_sales_collection_lines_invoice UNIQUE (collection_id, invoice_id),
  CONSTRAINT fk_sales_collection_lines_collection
    FOREIGN KEY (company_id, collection_id) REFERENCES sales_collections(company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_sales_collection_lines_invoice
    FOREIGN KEY (invoice_id, company_id) REFERENCES sales_invoices(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_sales_collection_lines_collection ON sales_collection_lines (company_id, collection_id);
CREATE INDEX IF NOT EXISTS idx_sales_collection_lines_invoice ON sales_collection_lines (company_id, invoice_id);

ALTER TABLE sales_collection_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_collection_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_collection_lines_tenant_isolation ON sales_collection_lines;
CREATE POLICY sales_collection_lines_tenant_isolation ON sales_collection_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_collection_lines TO an_app;
REVOKE ALL ON sales_collection_lines FROM PUBLIC, anon, authenticated;
