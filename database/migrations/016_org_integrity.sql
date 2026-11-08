-- Migration 016: Organizational Data Integrity & Composite Tenant Foreign Keys
-- Precheck: Requires migration 014_org_units.sql applied.
-- Ensures that parent org units, user org scopes, accounts, and journal entries/lines strictly reference org units belonging to the SAME company_id.

-- 1. Add UNIQUE constraint on org_units(company_id, id) so composite FKs can reference (company_id, id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_org_units_company_id_id'
  ) THEN
    ALTER TABLE org_units ADD CONSTRAINT uq_org_units_company_id_id UNIQUE (company_id, id);
  END IF;
END $$;

-- 2. Parent org unit same-company composite FK on org_units
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT constraint_name 
    FROM information_schema.key_column_usage 
    WHERE table_name = 'org_units' AND column_name = 'parent_id'
  ) LOOP
    EXECUTE 'ALTER TABLE org_units DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_org_units_parent_company'
  ) THEN
    ALTER TABLE org_units
      ADD CONSTRAINT fk_org_units_parent_company
      FOREIGN KEY (company_id, parent_id)
      REFERENCES org_units (company_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- 3. user_org_scope same-company composite FK
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT constraint_name 
    FROM information_schema.key_column_usage 
    WHERE table_name = 'user_org_scope' AND column_name = 'org_unit_id'
  ) LOOP
    EXECUTE 'ALTER TABLE user_org_scope DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_org_scope_company_unit'
  ) THEN
    ALTER TABLE user_org_scope
      ADD CONSTRAINT fk_user_org_scope_company_unit
      FOREIGN KEY (company_id, org_unit_id)
      REFERENCES org_units (company_id, id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- 4. accounts org_unit_id same-company composite FK
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT constraint_name 
    FROM information_schema.key_column_usage 
    WHERE table_name = 'accounts' AND column_name = 'org_unit_id'
  ) LOOP
    EXECUTE 'ALTER TABLE accounts DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_accounts_company_org_unit'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT fk_accounts_company_org_unit
      FOREIGN KEY (company_id, org_unit_id)
      REFERENCES org_units (company_id, id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 5. journal_entries org_unit_id same-company composite FK
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT constraint_name 
    FROM information_schema.key_column_usage 
    WHERE table_name = 'journal_entries' AND column_name = 'org_unit_id'
  ) LOOP
    EXECUTE 'ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_entries_company_org_unit'
  ) THEN
    ALTER TABLE journal_entries
      ADD CONSTRAINT fk_journal_entries_company_org_unit
      FOREIGN KEY (company_id, org_unit_id)
      REFERENCES org_units (company_id, id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 6. journal_lines org_unit_id same-company composite FK
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT constraint_name 
    FROM information_schema.key_column_usage 
    WHERE table_name = 'journal_lines' AND column_name = 'org_unit_id'
  ) LOOP
    EXECUTE 'ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_lines_company_org_unit'
  ) THEN
    ALTER TABLE journal_lines
      ADD CONSTRAINT fk_journal_lines_company_org_unit
      FOREIGN KEY (company_id, org_unit_id)
      REFERENCES org_units (company_id, id)
      ON DELETE SET NULL;
  END IF;
END $$;
