-- ==============================================================================
-- Migration 085: Company groups (additive, platform-level)
-- A group holds several companies. Each company keeps its own warehouses, accounts and
-- statements (tenant RLS is unchanged). Group tables are global catalog tables like companies.
-- A company belongs to at most one group. Group users have a group role: group_admin or group_viewer.
-- Rollback: DROP TABLE company_group_users, company_group_members, company_groups;
--           and delete the 085 row from schema_migrations.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS company_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) NOT NULL UNIQUE,
  name_ar VARCHAR(255) NOT NULL,
  name_en VARCHAR(255),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_group_members (
  group_id UUID NOT NULL REFERENCES company_groups(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  added_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, company_id),
  CONSTRAINT uq_company_single_group UNIQUE (company_id)
);

CREATE TABLE IF NOT EXISTS company_group_users (
  group_id UUID NOT NULL REFERENCES company_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role VARCHAR(30) NOT NULL CHECK (role IN ('group_admin', 'group_viewer')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  added_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_company_group_users_user ON company_group_users(user_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_groups', 'company_group_members', 'company_group_users'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_app_policy', t);
    EXECUTE format('CREATE POLICY %I ON %I TO an_app USING (true) WITH CHECK (true)', t || '_app_policy', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO an_app', t);
  END LOOP;
END $$;
