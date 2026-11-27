-- ==============================================================================
-- Migration 078: Multi-line cash receipt & payment vouchers (additive)
-- Each voucher can carry up to 100 lines (account + amount + memo).
-- Header amount = sum(lines); header contra_account_id = first line account
-- (kept for backward compatibility with existing single-line vouchers).
-- Existing vouchers are untouched: no lines rows means legacy single-line.
-- Rollback: DROP TABLE cash_receipt_voucher_lines; DROP TABLE cash_payment_voucher_lines;
--           and delete the 078 row from schema_migrations.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS cash_receipt_voucher_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  voucher_id UUID NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no >= 1 AND line_no <= 100),
  account_id UUID NOT NULL,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  memo TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cash_receipt_voucher_lines_no UNIQUE (voucher_id, line_no),
  CONSTRAINT fk_cash_receipt_voucher_lines_voucher
    FOREIGN KEY (company_id, voucher_id) REFERENCES cash_receipt_vouchers(company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_cash_receipt_voucher_lines_account
    FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_cash_receipt_voucher_lines_voucher ON cash_receipt_voucher_lines (company_id, voucher_id);

CREATE TABLE IF NOT EXISTS cash_payment_voucher_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  voucher_id UUID NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no >= 1 AND line_no <= 100),
  account_id UUID NOT NULL,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  memo TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cash_payment_voucher_lines_no UNIQUE (voucher_id, line_no),
  CONSTRAINT fk_cash_payment_voucher_lines_voucher
    FOREIGN KEY (company_id, voucher_id) REFERENCES cash_payment_vouchers(company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_cash_payment_voucher_lines_account
    FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_cash_payment_voucher_lines_voucher ON cash_payment_voucher_lines (company_id, voucher_id);

ALTER TABLE cash_receipt_voucher_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_receipt_voucher_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE cash_payment_voucher_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_payment_voucher_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cash_receipt_voucher_lines_tenant_isolation ON cash_receipt_voucher_lines;
CREATE POLICY cash_receipt_voucher_lines_tenant_isolation ON cash_receipt_voucher_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS cash_payment_voucher_lines_tenant_isolation ON cash_payment_voucher_lines;
CREATE POLICY cash_payment_voucher_lines_tenant_isolation ON cash_payment_voucher_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON cash_receipt_voucher_lines TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cash_payment_voucher_lines TO an_app;
REVOKE ALL ON cash_receipt_voucher_lines FROM PUBLIC, anon, authenticated;
REVOKE ALL ON cash_payment_voucher_lines FROM PUBLIC, anon, authenticated;
