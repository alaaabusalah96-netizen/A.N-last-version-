-- Migration 013: Ledger Guarantees, Sequences, Minimal Periods, and Immutability Triggers
-- Precheck: Requires migration 011_accounting_core.sql applied (accounts, journal_entries, journal_lines).
-- Applies to tenant tables with Row Level Security (RLS) for role an_app.

-- 1. Table: accounting_sequences (Thread-safe monotonic document sequence counter per company)
CREATE TABLE IF NOT EXISTS accounting_sequences (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_type VARCHAR(50) NOT NULL, -- e.g. 'journal_entry'
  prefix VARCHAR(20) NULL,
  next_value BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, doc_type)
);

CREATE INDEX IF NOT EXISTS idx_accounting_sequences_company ON accounting_sequences(company_id);

-- 2. Table: accounting_periods (Accounting Period control for fiscal dates)
CREATE TABLE IF NOT EXISTS accounting_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL, -- e.g. '2026-01'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  is_closed BOOLEAN NOT NULL DEFAULT false,
  closed_at TIMESTAMPTZ NULL,
  closed_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_company_period_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_accounting_periods_company_dates ON accounting_periods(company_id, start_date, end_date);

-- 3. Alterations to journal_entries: entry_no, period_id, posted metadata, reversal link
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS entry_no VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS period_id UUID NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS posted_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversed_by_entry_id UUID NULL REFERENCES journal_entries(id) ON DELETE SET NULL;

-- Unique human-readable entry number per company once assigned
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_company_entry_no 
  ON journal_entries(company_id, entry_no) 
  WHERE entry_no IS NOT NULL;

-- 4. Alterations and Constraints on journal_lines
-- Movement & non-negative amounts constraints
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_journal_lines_amounts'
  ) THEN
    ALTER TABLE journal_lines
      ADD CONSTRAINT chk_journal_lines_amounts 
      CHECK (debit >= 0 AND credit >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_journal_lines_one_sided'
  ) THEN
    ALTER TABLE journal_lines
      ADD CONSTRAINT chk_journal_lines_one_sided 
      CHECK (NOT (debit > 0 AND credit > 0));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_journal_lines_has_movement'
  ) THEN
    ALTER TABLE journal_lines
      ADD CONSTRAINT chk_journal_lines_has_movement 
      CHECK (debit > 0 OR credit > 0);
  END IF;
END $$;

-- 5. Immutability Triggers for Posted Entries and Lines
CREATE OR REPLACE FUNCTION trg_fn_journal_entries_immutability()
RETURNS TRIGGER AS $$
BEGIN
  -- If entry was already posted, reject ANY update or delete except linking reversed_by_entry_id
  IF OLD.status = 'posted' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'CANNOT_DELETE_POSTED_ENTRY: Posted journal entry % is immutable and cannot be deleted.', OLD.id;
    ELSIF TG_OP = 'UPDATE' THEN
      -- Allow solely updating reversed_by_entry_id on a posted entry
      IF NEW.id = OLD.id 
         AND NEW.company_id = OLD.company_id 
         AND NEW.entry_date = OLD.entry_date 
         AND NEW.entry_no IS NOT DISTINCT FROM OLD.entry_no
         AND NEW.memo IS NOT DISTINCT FROM OLD.memo 
         AND NEW.status = OLD.status 
         AND NEW.posted_at IS NOT DISTINCT FROM OLD.posted_at
         AND NEW.posted_by IS NOT DISTINCT FROM OLD.posted_by
         AND NEW.reversed_by_entry_id IS NOT NULL 
         AND OLD.reversed_by_entry_id IS NULL THEN
        RETURN NEW;
      ELSE
        RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_ENTRY: Posted journal entry % is immutable. Reversal requires a new reversing entry.', OLD.id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_entries_immutability ON journal_entries;
CREATE TRIGGER trg_journal_entries_immutability
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_journal_entries_immutability();

CREATE OR REPLACE FUNCTION trg_fn_journal_lines_immutability()
RETURNS TRIGGER AS $$
DECLARE
  v_parent_status VARCHAR(20);
BEGIN
  SELECT status INTO v_parent_status FROM journal_entries WHERE id = OLD.entry_id;
  IF v_parent_status = 'posted' THEN
    RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_LINES: Lines of posted journal entry % cannot be modified or deleted.', OLD.entry_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_lines_immutability ON journal_lines;
CREATE TRIGGER trg_journal_lines_immutability
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_journal_lines_immutability();

-- 6. Enable and Force Row Level Security (RLS) on new tables
ALTER TABLE accounting_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_sequences FORCE ROW LEVEL SECURITY;

ALTER TABLE accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_periods FORCE ROW LEVEL SECURITY;

-- 7. Tenant Isolation Policies for role an_app
DROP POLICY IF EXISTS accounting_sequences_tenant_isolation ON accounting_sequences;
CREATE POLICY accounting_sequences_tenant_isolation ON accounting_sequences
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS accounting_periods_tenant_isolation ON accounting_periods;
CREATE POLICY accounting_periods_tenant_isolation ON accounting_periods
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 8. Grant privileges to application role an_app
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_sequences TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_periods TO an_app;

-- 9. Revoke untrusted public/anon/authenticated grants
REVOKE ALL ON accounting_sequences FROM PUBLIC, anon, authenticated;
REVOKE ALL ON accounting_periods FROM PUBLIC, anon, authenticated;
