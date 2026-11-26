-- Migration 068: one journal entry per stock document (a debit and a credit line per item line).
-- Additive and nullable: documents posted before this migration keep their per-line journal
-- entries and simply have journal_entry_id NULL. No existing row is modified.

ALTER TABLE inv_stock_documents ADD COLUMN IF NOT EXISTS journal_entry_id UUID NULL;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_documents_journal') THEN
    ALTER TABLE inv_stock_documents ADD CONSTRAINT fk_inv_stock_documents_journal
      FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id) ON DELETE RESTRICT;
  END IF;
END
$do$;
GRANT UPDATE (journal_entry_id) ON inv_stock_documents TO an_app;
