-- Migration 012: Company Settings
-- Per-company operational settings with Row Level Security (RLS) for role an_app

CREATE TABLE IF NOT EXISTS company_settings (
  company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  default_currency_code VARCHAR(10) NOT NULL DEFAULT 'EGP',
  timezone VARCHAR(64) NOT NULL DEFAULT 'Africa/Cairo',
  fiscal_year_start_month INT NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  fiscal_year_start_day INT NOT NULL DEFAULT 1 CHECK (fiscal_year_start_day BETWEEN 1 AND 28),
  display_name_finance VARCHAR(255),
  locale VARCHAR(20) DEFAULT 'ar-EG',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES platform_users(id) ON DELETE SET NULL
);

-- Enable and Force Row Level Security (RLS)
ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_settings FORCE ROW LEVEL SECURITY;

-- Tenant Isolation Policy for role an_app
DROP POLICY IF EXISTS company_settings_tenant_isolation ON company_settings;
CREATE POLICY company_settings_tenant_isolation ON company_settings
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Grant privileges to application role an_app
GRANT SELECT, INSERT, UPDATE, DELETE ON company_settings TO an_app;

-- Revoke untrusted public/anon/authenticated grants
REVOKE ALL ON company_settings FROM PUBLIC, anon, authenticated;
