-- Migration 058: Running custody with independent vouchers (AN-ERP-R08-P1)
-- Each voucher (حافظة) carries expense lines, goes submitted -> approved/rejected,
-- and an approved voucher posts its own journal entry while the custody stays open.
-- History is kept: triggers block DELETE and any change to a decided voucher (the app-role
-- provisioning step grants DELETE broadly, so grants alone are not a guard).

CREATE TABLE IF NOT EXISTS custody_vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  custody_id UUID NOT NULL,
  voucher_seq INTEGER NOT NULL CHECK (voucher_seq > 0),
  voucher_no VARCHAR(80) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','approved','rejected')),
  total_amount NUMERIC(15,2) NOT NULL CHECK (total_amount > 0),
  memo TEXT NULL,
  submitted_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by UUID NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  decided_at TIMESTAMPTZ NULL,
  reject_reason TEXT NULL,
  journal_entry_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_custody_vouchers_company_id_id UNIQUE (company_id, id),
  CONSTRAINT uq_custody_vouchers_custody_seq UNIQUE (company_id, custody_id, voucher_seq),
  CONSTRAINT fk_custody_vouchers_custody_company
    FOREIGN KEY (custody_id, company_id) REFERENCES custody_records(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_custody_vouchers_je_company
    FOREIGN KEY (journal_entry_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT chk_custody_vouchers_state CHECK (
    (status = 'submitted' AND decided_by IS NULL AND decided_at IS NULL AND journal_entry_id IS NULL)
    OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND journal_entry_id IS NOT NULL)
    OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
        AND reject_reason IS NOT NULL AND btrim(reject_reason) <> '' AND journal_entry_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_custody_vouchers_company_custody
  ON custody_vouchers (company_id, custody_id, status);

CREATE TABLE IF NOT EXISTS custody_voucher_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  voucher_id UUID NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  expense_account_id UUID NOT NULL,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  memo TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_custody_voucher_lines_no UNIQUE (company_id, voucher_id, line_no),
  CONSTRAINT fk_custody_voucher_lines_voucher_company
    FOREIGN KEY (voucher_id, company_id) REFERENCES custody_vouchers(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_custody_voucher_lines_account_company
    FOREIGN KEY (expense_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);

ALTER TABLE custody_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE custody_vouchers FORCE ROW LEVEL SECURITY;
ALTER TABLE custody_voucher_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE custody_voucher_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custody_vouchers_tenant_isolation ON custody_vouchers;
CREATE POLICY custody_vouchers_tenant_isolation ON custody_vouchers
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS custody_voucher_lines_tenant_isolation ON custody_voucher_lines;
CREATE POLICY custody_voucher_lines_tenant_isolation ON custody_voucher_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON custody_vouchers TO an_app;
GRANT SELECT, INSERT ON custody_voucher_lines TO an_app;

CREATE OR REPLACE FUNCTION custody_vouchers_guard() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'custody_vouchers rows cannot be deleted (history is kept)';
  END IF;
  IF OLD.status <> 'submitted' THEN
    RAISE EXCEPTION 'custody voucher % is already % and cannot be changed', OLD.id, OLD.status;
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.custody_id <> OLD.custody_id
     OR NEW.voucher_seq <> OLD.voucher_seq OR NEW.voucher_no <> OLD.voucher_no
     OR NEW.total_amount <> OLD.total_amount OR NEW.submitted_by <> OLD.submitted_by THEN
    RAISE EXCEPTION 'custody voucher core fields are immutable';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_custody_vouchers_guard ON custody_vouchers;
CREATE TRIGGER trg_custody_vouchers_guard
  BEFORE UPDATE OR DELETE ON custody_vouchers
  FOR EACH ROW EXECUTE FUNCTION custody_vouchers_guard();

CREATE OR REPLACE FUNCTION custody_voucher_lines_guard() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'custody_voucher_lines rows are immutable (history is kept)';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_custody_voucher_lines_guard ON custody_voucher_lines;
CREATE TRIGGER trg_custody_voucher_lines_guard
  BEFORE UPDATE OR DELETE ON custody_voucher_lines
  FOR EACH ROW EXECUTE FUNCTION custody_voucher_lines_guard();
REVOKE ALL ON custody_vouchers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON custody_voucher_lines FROM PUBLIC, anon, authenticated;
