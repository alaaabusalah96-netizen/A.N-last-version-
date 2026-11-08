-- Migration 015: Ledger Hardening - Immutability & DB Balance Verification
-- Precheck: Requires migration 013_ledger_guarantees.sql and 014_org_units.sql applied.
-- Applies to tenant tables with Row Level Security (RLS) for role an_app.

-- 1. Block INSERT, UPDATE, and DELETE on journal_lines when parent entry is posted
CREATE OR REPLACE FUNCTION trg_fn_journal_lines_immutability()
RETURNS TRIGGER AS $$
DECLARE
  v_entry_id UUID;
  v_parent_status VARCHAR(20);
BEGIN
  v_entry_id := COALESCE(NEW.entry_id, OLD.entry_id);
  IF v_entry_id IS NOT NULL THEN
    SELECT status INTO v_parent_status FROM journal_entries WHERE id = v_entry_id;
    IF v_parent_status = 'posted' THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_LINES: Lines of posted journal entry % cannot be inserted, modified, or deleted.', v_entry_id;
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


-- 2. Narrow posted entry immutability AND enforce DB-level balance check on transition to posted
CREATE OR REPLACE FUNCTION trg_fn_journal_entries_immutability()
RETURNS TRIGGER AS $$
DECLARE
  v_total_debit NUMERIC;
  v_total_credit NUMERIC;
  v_lines_count INT;
BEGIN
  -- A. Immutability check when entry was ALREADY posted
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'CANNOT_DELETE_POSTED_ENTRY: Posted journal entry % is immutable and cannot be deleted.', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    -- Strictly allow ONLY setting reversed_by_entry_id from NULL to non-NULL UUID, leaving all other business columns identical
    IF NEW.id = OLD.id 
       AND NEW.company_id = OLD.company_id 
       AND NEW.entry_date = OLD.entry_date 
       AND NEW.entry_no IS NOT DISTINCT FROM OLD.entry_no
       AND NEW.memo IS NOT DISTINCT FROM OLD.memo 
       AND NEW.period_id IS NOT DISTINCT FROM OLD.period_id
       AND NEW.status = OLD.status 
       AND NEW.posted_at IS NOT DISTINCT FROM OLD.posted_at
       AND NEW.posted_by IS NOT DISTINCT FROM OLD.posted_by
       AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
       AND NEW.org_unit_id IS NOT DISTINCT FROM OLD.org_unit_id
       AND NEW.reversed_by_entry_id IS NOT NULL 
       AND OLD.reversed_by_entry_id IS NULL THEN
      RETURN NEW;
    ELSE
      RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_ENTRY: Posted journal entry % is immutable. Period, date, memo, amounts, and org unit cannot be altered after posting.', OLD.id;
    END IF;
  END IF;

  -- B. Balance verification on transition to 'posted'
  IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') AND NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'posted') THEN
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*)
      INTO v_total_debit, v_total_credit, v_lines_count
      FROM journal_lines
     WHERE entry_id = NEW.id AND company_id = NEW.company_id;

    IF v_lines_count < 2 THEN
      RAISE EXCEPTION 'UNBALANCED_JOURNAL_ENTRY: Cannot post journal entry % with fewer than 2 lines (found %).', NEW.id, v_lines_count;
    END IF;

    IF v_total_debit <= 0 THEN
      RAISE EXCEPTION 'UNBALANCED_JOURNAL_ENTRY: Cannot post journal entry % with zero or negative total amount.', NEW.id;
    END IF;

    IF v_total_debit <> v_total_credit THEN
      RAISE EXCEPTION 'UNBALANCED_JOURNAL_ENTRY: Total debit (%) must equal total credit (%) for posted journal entry %.', v_total_debit, v_total_credit, NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_entries_immutability ON journal_entries;
CREATE TRIGGER trg_journal_entries_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_journal_entries_immutability();
