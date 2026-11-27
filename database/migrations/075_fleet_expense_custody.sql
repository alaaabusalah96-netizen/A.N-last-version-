-- Migration 075: fleet phase (c2): a fleet expense can be paid from an employee's open custody.
-- Additive only: one nullable column, one FK, one partial unique index. Nothing existing is changed.
-- The expense links to a custody voucher (existing custody flow). The voucher approver (not the submitter) posts it;
-- the fleet expense follows the voucher: approved -> posted, rejected -> link cleared, reversed -> reversed.
ALTER TABLE fleet_expenses ADD COLUMN IF NOT EXISTS custody_voucher_id UUID NULL;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fleet_expenses_custody_voucher') THEN
    ALTER TABLE fleet_expenses ADD CONSTRAINT fk_fleet_expenses_custody_voucher
      FOREIGN KEY (company_id, custody_voucher_id) REFERENCES custody_vouchers (company_id, id) ON DELETE RESTRICT;
  END IF;
END $do$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fleet_expenses_custody_voucher ON fleet_expenses (company_id, custody_voucher_id) WHERE custody_voucher_id IS NOT NULL;
