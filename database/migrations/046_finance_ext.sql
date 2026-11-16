-- Migration 046: Finance Extensions (AN-FINANCE-EXT-1)
-- Merges:
-- 1) AN-BANK-RECONCILE-1: Bank accounts master, statement lines, and simplified reconciliations
-- 2) AN-YEAR-CLOSE-1: Fiscal year closing log and closing JE reference on top of accounting_periods
-- 3) RLS policies for an_app, composite tenant foreign keys, grants & revokes

-- 0. Ensure journal_lines has composite (company_id, id) unique constraint for tenant-safe matching FKs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_journal_lines_company_id_id'
  ) THEN
    ALTER TABLE journal_lines ADD CONSTRAINT uq_journal_lines_company_id_id UNIQUE (company_id, id);
  END IF;
END $$;

-- 1. Bank Accounts Master Table (حسابات البنوك المرتبطة بالدليل المحاسبي)
CREATE TABLE IF NOT EXISTS fin_bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,
  name_ar VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NULL,
  bank_name VARCHAR(255) NOT NULL,
  account_number VARCHAR(100) NULL,
  iban VARCHAR(64) NULL,
  currency_code VARCHAR(10) NOT NULL DEFAULT 'SAR',
  gl_account_id UUID NOT NULL,
  opening_balance NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
  is_active BOOLEAN NOT NULL DEFAULT true,
  memo TEXT NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fin_bank_accounts_company_code UNIQUE (company_id, code),
  CONSTRAINT uq_fin_bank_accounts_company_gl UNIQUE (company_id, gl_account_id),
  CONSTRAINT uq_fin_bank_accounts_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_fin_bank_accounts_gl
    FOREIGN KEY (gl_account_id, company_id)
    REFERENCES accounts (id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fin_bank_accounts_company ON fin_bank_accounts(company_id, is_active);

-- 2. Bank Reconciliations Header Table (جلسات التسوية البنكية)
CREATE TABLE IF NOT EXISTS fin_bank_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL,
  statement_end_date DATE NOT NULL,
  statement_ending_balance NUMERIC(15, 2) NOT NULL,
  book_balance NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
  unmatched_statement_net NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
  unmatched_book_net NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
  difference_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  memo TEXT NULL,
  completed_at TIMESTAMPTZ NULL,
  completed_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fin_bank_reconciliations_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_fin_bank_reconciliations_account
    FOREIGN KEY (bank_account_id, company_id)
    REFERENCES fin_bank_accounts (id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fin_bank_reconciliations_account
  ON fin_bank_reconciliations(company_id, bank_account_id, statement_end_date DESC);

-- 3. Bank Statement Lines Table (سطور كشف الحساب البنكي)
CREATE TABLE IF NOT EXISTS fin_bank_statement_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL,
  statement_date DATE NOT NULL,
  value_date DATE NULL,
  reference VARCHAR(120) NULL,
  description TEXT NOT NULL,
  debit_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (debit_amount >= 0),
  credit_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (credit_amount >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched')),
  matched_journal_line_id UUID NULL,
  reconciliation_id UUID NULL,
  matched_at TIMESTAMPTZ NULL,
  matched_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_fin_bank_stmt_lines_one_sided
    CHECK ((debit_amount > 0 AND credit_amount = 0) OR (credit_amount > 0 AND debit_amount = 0)),
  CONSTRAINT uq_fin_bank_stmt_lines_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_fin_bank_stmt_lines_account
    FOREIGN KEY (bank_account_id, company_id)
    REFERENCES fin_bank_accounts (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_fin_bank_stmt_lines_jl
    FOREIGN KEY (matched_journal_line_id, company_id)
    REFERENCES journal_lines (id, company_id)
    ON DELETE SET NULL,
  CONSTRAINT fk_fin_bank_stmt_lines_recon
    FOREIGN KEY (reconciliation_id, company_id)
    REFERENCES fin_bank_reconciliations (id, company_id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fin_bank_stmt_lines_account_date
  ON fin_bank_statement_lines(company_id, bank_account_id, statement_date DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_bank_stmt_lines_matched_jl
  ON fin_bank_statement_lines(company_id, matched_journal_line_id)
  WHERE matched_journal_line_id IS NOT NULL;

-- 4. Fiscal Year Closes Table (سجل إقفال السنوات المالية وترحيل النتيجة)
CREATE TABLE IF NOT EXISTS fin_fiscal_year_closes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_code VARCHAR(50) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  retained_earnings_account_id UUID NOT NULL,
  closing_journal_entry_id UUID NULL,
  total_revenue NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
  total_expenses NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
  net_income NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
  closed_periods_count INT NOT NULL DEFAULT 0,
  notes TEXT NULL,
  closed_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_fin_fiscal_year_dates CHECK (start_date <= end_date),
  CONSTRAINT uq_fin_fiscal_year_closes_company_code UNIQUE (company_id, fiscal_year_code),
  CONSTRAINT uq_fin_fiscal_year_closes_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_fin_year_closes_re_account
    FOREIGN KEY (retained_earnings_account_id, company_id)
    REFERENCES accounts (id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_fin_year_closes_je
    FOREIGN KEY (closing_journal_entry_id, company_id)
    REFERENCES journal_entries (id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fin_fiscal_year_closes_company
  ON fin_fiscal_year_closes(company_id, end_date DESC);

-- 5. Enable and Force RLS on all finance extension tables
ALTER TABLE fin_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_bank_accounts FORCE ROW LEVEL SECURITY;

ALTER TABLE fin_bank_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_bank_reconciliations FORCE ROW LEVEL SECURITY;

ALTER TABLE fin_bank_statement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_bank_statement_lines FORCE ROW LEVEL SECURITY;

ALTER TABLE fin_fiscal_year_closes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_fiscal_year_closes FORCE ROW LEVEL SECURITY;

-- 6. Tenant isolation policies for application role an_app
DROP POLICY IF EXISTS fin_bank_accounts_tenant_isolation ON fin_bank_accounts;
CREATE POLICY fin_bank_accounts_tenant_isolation ON fin_bank_accounts
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS fin_bank_reconciliations_tenant_isolation ON fin_bank_reconciliations;
CREATE POLICY fin_bank_reconciliations_tenant_isolation ON fin_bank_reconciliations
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS fin_bank_statement_lines_tenant_isolation ON fin_bank_statement_lines;
CREATE POLICY fin_bank_statement_lines_tenant_isolation ON fin_bank_statement_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS fin_fiscal_year_closes_tenant_isolation ON fin_fiscal_year_closes;
CREATE POLICY fin_fiscal_year_closes_tenant_isolation ON fin_fiscal_year_closes
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 7. Grants & Revokes
GRANT SELECT, INSERT, UPDATE, DELETE ON fin_bank_accounts TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON fin_bank_reconciliations TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON fin_bank_statement_lines TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON fin_fiscal_year_closes TO an_app;

REVOKE ALL ON fin_bank_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON fin_bank_reconciliations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON fin_bank_statement_lines FROM PUBLIC, anon, authenticated;
REVOKE ALL ON fin_fiscal_year_closes FROM PUBLIC, anon, authenticated;
