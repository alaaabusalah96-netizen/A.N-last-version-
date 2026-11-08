-- Migration 014: Company Organizational Units & User Org Scopes (ADR-01)
-- Precheck: Requires migrations 011_accounting_core.sql and 013_ledger_guarantees.sql.
-- Tenant-scoped tables with Row Level Security (RLS) for role an_app.

-- 1. Table: org_units (Adjacency list + path hierarchy within company boundary)
CREATE TABLE IF NOT EXISTS org_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id UUID NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  code VARCHAR(50) NOT NULL,
  name_ar VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NULL,
  unit_type VARCHAR(30) NOT NULL CHECK (unit_type IN ('branch', 'department', 'cost_center', 'division')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  path TEXT NOT NULL DEFAULT '/',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_company_org_unit_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_org_units_company ON org_units(company_id);
CREATE INDEX IF NOT EXISTS idx_org_units_parent ON org_units(parent_id);
CREATE INDEX IF NOT EXISTS idx_org_units_path ON org_units(path text_pattern_ops);

-- 2. Table: user_org_scope (Grants user visibility/access to specific organizational units within tenant)
CREATE TABLE IF NOT EXISTS user_org_scope (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  org_unit_id UUID NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
  include_descendants BOOLEAN NOT NULL DEFAULT true,
  access_level VARCHAR(10) NOT NULL DEFAULT 'read' CHECK (access_level IN ('read', 'write')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, org_unit_id)
);

CREATE INDEX IF NOT EXISTS idx_user_org_scope_company ON user_org_scope(company_id);
CREATE INDEX IF NOT EXISTS idx_user_org_scope_user ON user_org_scope(company_id, user_id);

-- 3. Nullable org_unit_id on accounting tables (011 / 013)
ALTER TABLE accounts 
  ADD COLUMN IF NOT EXISTS org_unit_id UUID NULL REFERENCES org_units(id) ON DELETE SET NULL;

ALTER TABLE journal_entries 
  ADD COLUMN IF NOT EXISTS org_unit_id UUID NULL REFERENCES org_units(id) ON DELETE SET NULL;

ALTER TABLE journal_lines 
  ADD COLUMN IF NOT EXISTS org_unit_id UUID NULL REFERENCES org_units(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_org_unit ON accounts(org_unit_id) WHERE org_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_org_unit ON journal_entries(org_unit_id) WHERE org_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_lines_org_unit ON journal_lines(org_unit_id) WHERE org_unit_id IS NOT NULL;

-- 4. Enable and Force Row Level Security (RLS)
ALTER TABLE org_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_units FORCE ROW LEVEL SECURITY;

ALTER TABLE user_org_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_org_scope FORCE ROW LEVEL SECURITY;

-- 5. Tenant Isolation Policies for role an_app
DROP POLICY IF EXISTS org_units_tenant_isolation ON org_units;
CREATE POLICY org_units_tenant_isolation ON org_units
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS user_org_scope_tenant_isolation ON user_org_scope;
CREATE POLICY user_org_scope_tenant_isolation ON user_org_scope
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 6. Grant privileges to application role an_app
GRANT SELECT, INSERT, UPDATE, DELETE ON org_units TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_org_scope TO an_app;

-- 7. Revoke untrusted public/anon/authenticated grants
REVOKE ALL ON org_units FROM PUBLIC, anon, authenticated;
REVOKE ALL ON user_org_scope FROM PUBLIC, anon, authenticated;
