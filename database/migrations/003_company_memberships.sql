CREATE TABLE IF NOT EXISTS company_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'company_user',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_company UNIQUE (user_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON company_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_company ON company_memberships(company_id);
