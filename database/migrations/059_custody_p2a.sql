-- Migration 059: Custody top-up, voucher reversal, cash counts (AN-ERP-R08-P2A)
--  1) custody_movements may record 'topup'.
--  2) An approved voucher can be reversed (status 'reversed') with its own reversing journal entry.
--  3) custody_cash_counts: append-only physical cash counts; variance is recorded, never auto-posted.

ALTER TABLE custody_movements DROP CONSTRAINT IF EXISTS custody_movements_movement_type_check;
ALTER TABLE custody_movements ADD CONSTRAINT custody_movements_movement_type_check
  CHECK (movement_type IN ('disburse','topup','settle_expense','settle_return','reverse'));

ALTER TABLE custody_vouchers
  ADD COLUMN IF NOT EXISTS reversed_by UUID NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id UUID NULL;

ALTER TABLE custody_vouchers DROP CONSTRAINT IF EXISTS custody_vouchers_status_check;
ALTER TABLE custody_vouchers ADD CONSTRAINT custody_vouchers_status_check
  CHECK (status IN ('submitted','approved','rejected','reversed'));

ALTER TABLE custody_vouchers DROP CONSTRAINT IF EXISTS fk_custody_vouchers_reversal_je_company;
ALTER TABLE custody_vouchers ADD CONSTRAINT fk_custody_vouchers_reversal_je_company
  FOREIGN KEY (reversal_journal_entry_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT;

ALTER TABLE custody_vouchers DROP CONSTRAINT IF EXISTS chk_custody_vouchers_state;
ALTER TABLE custody_vouchers ADD CONSTRAINT chk_custody_vouchers_state CHECK (
  (status = 'submitted' AND decided_by IS NULL AND decided_at IS NULL AND journal_entry_id IS NULL
     AND reversed_by IS NULL AND reversal_journal_entry_id IS NULL)
  OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND journal_entry_id IS NOT NULL
     AND reversed_by IS NULL AND reversal_journal_entry_id IS NULL)
  OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
     AND reject_reason IS NOT NULL AND btrim(reject_reason) <> '' AND journal_entry_id IS NULL
     AND reversed_by IS NULL AND reversal_journal_entry_id IS NULL)
  OR (status = 'reversed' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND journal_entry_id IS NOT NULL
     AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL AND reversal_journal_entry_id IS NOT NULL
     AND reversal_reason IS NOT NULL AND btrim(reversal_reason) <> '')
);

CREATE OR REPLACE FUNCTION custody_vouchers_guard() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'custody_vouchers rows cannot be deleted (history is kept)';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.custody_id <> OLD.custody_id
     OR NEW.voucher_seq <> OLD.voucher_seq OR NEW.voucher_no <> OLD.voucher_no
     OR NEW.total_amount <> OLD.total_amount OR NEW.submitted_by <> OLD.submitted_by THEN
    RAISE EXCEPTION 'custody voucher core fields are immutable';
  END IF;
  IF OLD.status = 'submitted' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'reversed'
     AND NEW.decided_by IS NOT DISTINCT FROM OLD.decided_by
     AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
     AND NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'custody voucher % is already % and cannot be changed', OLD.id, OLD.status;
END;
$fn$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS custody_cash_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  custody_id UUID NOT NULL,
  counted_amount NUMERIC(15,2) NOT NULL CHECK (counted_amount >= 0),
  expected_amount NUMERIC(15,2) NOT NULL CHECK (expected_amount >= 0),
  variance NUMERIC(15,2) NOT NULL,
  memo TEXT NULL,
  counted_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  counted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_custody_cash_counts_variance CHECK (variance = counted_amount - expected_amount),
  CONSTRAINT fk_custody_cash_counts_custody_company
    FOREIGN KEY (custody_id, company_id) REFERENCES custody_records(id, company_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_custody_cash_counts_company_custody
  ON custody_cash_counts (company_id, custody_id, counted_at DESC);

ALTER TABLE custody_cash_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE custody_cash_counts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custody_cash_counts_tenant_isolation ON custody_cash_counts;
CREATE POLICY custody_cash_counts_tenant_isolation ON custody_cash_counts
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON custody_cash_counts TO an_app;
REVOKE ALL ON custody_cash_counts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION custody_cash_counts_guard() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'custody_cash_counts rows are immutable (history is kept)';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_custody_cash_counts_guard ON custody_cash_counts;
CREATE TRIGGER trg_custody_cash_counts_guard
  BEFORE UPDATE OR DELETE ON custody_cash_counts
  FOR EACH ROW EXECUTE FUNCTION custody_cash_counts_guard();
