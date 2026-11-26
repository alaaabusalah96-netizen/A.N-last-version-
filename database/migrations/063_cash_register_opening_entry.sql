-- Migration 063: a cash register opening balance must exist on the ledger.
-- Link each register to the journal entry that posted its opening balance (Dr cash account / Cr equity offset).
ALTER TABLE cash_registers ADD COLUMN IF NOT EXISTS opening_journal_entry_id UUID NULL;
