-- Migration 022: Ledger Composite Foreign Keys (Data Integrity Hardening)
-- Enforces tenant isolation integrity at the database level for accounting journal lines
-- preventing cross-tenant journal line contamination.

-- 1. Pre-migration orphan & cross-company mismatch check
-- Raises a fatal exception if any orphan or company_id mismatch exists between journal_lines and journal_entries / accounts.
DO $$
DECLARE
  orphan_count INT;
BEGIN
  -- Check journal_lines referencing non-existent or mismatched company_id journal_entries
  SELECT COUNT(*) INTO orphan_count
  FROM journal_lines l
  LEFT JOIN journal_entries e ON l.entry_id = e.id
  WHERE e.id IS NULL OR l.company_id <> e.company_id;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 022 ABORTED: Found % journal_lines with missing or cross-company entry_id reference!', orphan_count;
  END IF;

  -- Check journal_lines referencing non-existent or mismatched company_id accounts
  SELECT COUNT(*) INTO orphan_count
  FROM journal_lines l
  LEFT JOIN accounts a ON l.account_id = a.id
  WHERE a.id IS NULL OR l.company_id <> a.company_id;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 022 ABORTED: Found % journal_lines with missing or cross-company account_id reference!', orphan_count;
  END IF;
END $$;

-- 2. Add composite UNIQUE constraints on parent tables (required for composite foreign key targets in PostgreSQL)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_accounts_company_id_id'
  ) THEN
    ALTER TABLE accounts ADD CONSTRAINT uq_accounts_company_id_id UNIQUE (company_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_journal_entries_company_id_id'
  ) THEN
    ALTER TABLE journal_entries ADD CONSTRAINT uq_journal_entries_company_id_id UNIQUE (company_id, id);
  END IF;
END $$;

-- 3. Drop old single-column foreign key constraints on journal_lines if present
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS journal_lines_entry_id_fkey;
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS journal_lines_account_id_fkey;

-- 4. Add composite FOREIGN KEY constraints on journal_lines ensuring company_id matches parent record exactly
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_lines_entry_company'
  ) THEN
    ALTER TABLE journal_lines 
      ADD CONSTRAINT fk_journal_lines_entry_company 
      FOREIGN KEY (entry_id, company_id) 
      REFERENCES journal_entries (id, company_id) 
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_lines_account_company'
  ) THEN
    ALTER TABLE journal_lines 
      ADD CONSTRAINT fk_journal_lines_account_company 
      FOREIGN KEY (account_id, company_id) 
      REFERENCES accounts (id, company_id) 
      ON DELETE RESTRICT;
  END IF;
END $$;
