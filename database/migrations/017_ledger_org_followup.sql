-- Migration 017: Ledger and Org Unit Integrity Follow-up Repair
-- Precheck: Requires migrations 015_ledger_hardening.sql and 016_org_integrity.sql applied.

-- 1. Fix composite foreign keys ON DELETE behavior on (company_id, org_unit_id)
-- Multi-column FK containing non-nullable company_id cannot use ON DELETE SET NULL.
-- Replacing with ON DELETE RESTRICT (deleting an org_unit with active references is prevented until cleared).

DO $$
BEGIN
  -- Accounts composite FK
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_accounts_company_org_unit') THEN
    ALTER TABLE accounts DROP CONSTRAINT fk_accounts_company_org_unit;
  END IF;
  ALTER TABLE accounts
    ADD CONSTRAINT fk_accounts_company_org_unit
    FOREIGN KEY (company_id, org_unit_id)
    REFERENCES org_units (company_id, id)
    ON DELETE RESTRICT;

  -- Journal entries composite FK
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_entries_company_org_unit') THEN
    ALTER TABLE journal_entries DROP CONSTRAINT fk_journal_entries_company_org_unit;
  END IF;
  ALTER TABLE journal_entries
    ADD CONSTRAINT fk_journal_entries_company_org_unit
    FOREIGN KEY (company_id, org_unit_id)
    REFERENCES org_units (company_id, id)
    ON DELETE RESTRICT;

  -- Journal lines composite FK
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_lines_company_org_unit') THEN
    ALTER TABLE journal_lines DROP CONSTRAINT fk_journal_lines_company_org_unit;
  END IF;
  ALTER TABLE journal_lines
    ADD CONSTRAINT fk_journal_lines_company_org_unit
    FOREIGN KEY (company_id, org_unit_id)
    REFERENCES org_units (company_id, id)
    ON DELETE RESTRICT;
END $$;


-- 2. Harden journal_lines immutability trigger function for INSERT, UPDATE (OLD and NEW), and DELETE
CREATE OR REPLACE FUNCTION trg_fn_journal_lines_immutability()
RETURNS TRIGGER AS $$
DECLARE
  v_parent_status VARCHAR(20);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.entry_id IS NOT NULL THEN
      SELECT status INTO v_parent_status FROM journal_entries WHERE id = NEW.entry_id;
      IF v_parent_status = 'posted' THEN
        RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_LINES: Cannot insert lines into posted journal entry %.', NEW.entry_id;
      END IF;
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.entry_id IS NOT NULL THEN
      SELECT status INTO v_parent_status FROM journal_entries WHERE id = OLD.entry_id;
      IF v_parent_status = 'posted' THEN
        RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_LINES: Cannot delete lines from posted journal entry %.', OLD.entry_id;
      END IF;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Check OLD entry status
    IF OLD.entry_id IS NOT NULL THEN
      SELECT status INTO v_parent_status FROM journal_entries WHERE id = OLD.entry_id;
      IF v_parent_status = 'posted' THEN
        RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_LINES: Cannot modify lines of posted journal entry %.', OLD.entry_id;
      END IF;
    END IF;

    -- Check NEW entry status if line is being re-assigned to a different entry
    IF NEW.entry_id IS NOT NULL AND NEW.entry_id IS DISTINCT FROM OLD.entry_id THEN
      SELECT status INTO v_parent_status FROM journal_entries WHERE id = NEW.entry_id;
      IF v_parent_status = 'posted' THEN
        RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_LINES: Cannot move line into posted journal entry %.', NEW.entry_id;
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_lines_immutability ON journal_lines;
CREATE TRIGGER trg_journal_lines_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_journal_lines_immutability();
