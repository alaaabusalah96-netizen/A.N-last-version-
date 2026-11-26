-- Migration 067: background posting jobs for large multi-line stock documents.
-- The document itself is still posted by one all-or-nothing transaction; the job row only tracks
-- queued / running / done / failed so the UI can poll instead of holding one long request.
-- Additive only.

CREATE TABLE IF NOT EXISTS inv_stock_document_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('receipt','issue','adjustment','transfer')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  payload JSONB NOT NULL,
  result JSONB NULL,
  error_message TEXT NULL,
  line_count INTEGER NOT NULL CHECK (line_count >= 1),
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_inv_stock_document_jobs_company ON inv_stock_document_jobs(company_id, created_at DESC);

ALTER TABLE inv_stock_document_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_stock_document_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inv_stock_document_jobs_tenant_isolation ON inv_stock_document_jobs;
CREATE POLICY inv_stock_document_jobs_tenant_isolation ON inv_stock_document_jobs TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON inv_stock_document_jobs TO an_app;
REVOKE ALL ON inv_stock_document_jobs FROM PUBLIC, anon, authenticated;
