-- Migration 011: Accounting Core (Chart of Accounts & Journal Skeleton)
-- Tenant-scoped tables with Row Level Security (RLS) for role an_app

-- 1. Accounts Table (Chart of Accounts)
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,
  name_ar VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NULL,
  account_type VARCHAR(50) NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  parent_id UUID NULL REFERENCES accounts(id) ON DELETE SET NULL,
  is_postable BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_accounts_company_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_accounts_company ON accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(company_id, account_type);
CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts(parent_id);

-- 2. Journal Entries (Skeleton for future posting engine)
CREATE TABLE IF NOT EXISTS journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  memo TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_company ON journal_entries(company_id, entry_date DESC);

-- 3. Journal Lines (Skeleton for future posting engine)
CREATE TABLE IF NOT EXISTS journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  debit NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (debit >= 0),
  credit NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (credit >= 0),
  line_memo TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);

-- 4. Enable and Force Row Level Security (RLS)
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;

ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;

-- 5. Tenant Isolation Policies for role an_app
DROP POLICY IF EXISTS accounts_tenant_isolation ON accounts;
CREATE POLICY accounts_tenant_isolation ON accounts
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS journal_entries_tenant_isolation ON journal_entries;
CREATE POLICY journal_entries_tenant_isolation ON journal_entries
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS journal_lines_tenant_isolation ON journal_lines;
CREATE POLICY journal_lines_tenant_isolation ON journal_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 6. Grant privileges to application role an_app
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON journal_entries TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON journal_lines TO an_app;

-- 7. Revoke untrusted public/anon/authenticated grants
REVOKE ALL ON accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON journal_entries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON journal_lines FROM PUBLIC, anon, authenticated;
