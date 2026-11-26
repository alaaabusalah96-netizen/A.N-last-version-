-- Migration 066: multi-line inventory documents (receipt, issue, adjustment, transfer).
-- A document is a header plus many lines posted in ONE transaction (all or nothing).
-- Additive only: existing single-line movements keep working and simply have no document.

CREATE TABLE IF NOT EXISTS inv_stock_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  doc_no TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('receipt','issue','adjustment','transfer')),
  entry_date DATE NULL,
  warehouse_id UUID NULL REFERENCES inv_warehouses(id) ON DELETE RESTRICT,
  dest_warehouse_id UUID NULL REFERENCES inv_warehouses(id) ON DELETE RESTRICT,
  reason TEXT NULL,
  memo TEXT NULL,
  line_count INTEGER NOT NULL CHECK (line_count >= 1),
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inv_stock_documents_no UNIQUE (company_id, doc_no),
  CONSTRAINT uq_inv_stock_documents_id_company UNIQUE (id, company_id)
);

ALTER TABLE inv_stock_movements ADD COLUMN IF NOT EXISTS document_id UUID NULL;
ALTER TABLE inv_stock_movements ADD COLUMN IF NOT EXISTS line_no INTEGER NULL;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_movements_document') THEN
    ALTER TABLE inv_stock_movements ADD CONSTRAINT fk_inv_stock_movements_document
      FOREIGN KEY (document_id, company_id) REFERENCES inv_stock_documents(id, company_id) ON DELETE RESTRICT;
  END IF;
END
$do$;
CREATE INDEX IF NOT EXISTS idx_inv_stock_movements_document ON inv_stock_movements(company_id, document_id, line_no);

ALTER TABLE inv_stock_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_stock_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inv_stock_documents_tenant_isolation ON inv_stock_documents;
CREATE POLICY inv_stock_documents_tenant_isolation ON inv_stock_documents TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON inv_stock_documents TO an_app;
REVOKE ALL ON inv_stock_documents FROM PUBLIC, anon, authenticated;
