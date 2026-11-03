CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  name_ar VARCHAR(255) NOT NULL,
  name_en VARCHAR(255),
  is_active BOOLEAN NOT NULL DEFAULT true,
  database_mode VARCHAR(50) NOT NULL DEFAULT 'central',
  database_connection_key VARCHAR(255),
  created_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_companies_code ON companies(code);
