-- Demo table for tenant isolation proof via RLS
CREATE TABLE IF NOT EXISTS tenant_demo_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_demo_company ON tenant_demo_items(company_id);

ALTER TABLE tenant_demo_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_demo_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_demo_isolation ON tenant_demo_items;
CREATE POLICY tenant_demo_isolation ON tenant_demo_items
  FOR ALL
  USING (company_id::text = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (company_id::text = NULLIF(current_setting('app.current_tenant_id', true), ''));
