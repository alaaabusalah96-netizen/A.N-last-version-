-- ==============================================================================
-- Migration 081: Multi-line fleet expenses (additive)
-- A fleet expense can carry up to 100 lines (category + amount + description each).
-- Header amount = sum(lines); header category_id = first line category (legacy compat).
-- Existing expenses are untouched: no lines rows means legacy single-line.
-- Rollback: DROP TABLE fleet_expense_lines; ALTER TABLE fleet_expenses DROP CONSTRAINT uq_fleet_expenses_company_id_id; and delete the 081 row from schema_migrations.
-- ==============================================================================
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_fleet_expenses_company_id_id') THEN
    ALTER TABLE fleet_expenses ADD CONSTRAINT uq_fleet_expenses_company_id_id UNIQUE (company_id, id);
  END IF;
END $do$;

CREATE TABLE IF NOT EXISTS fleet_expense_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  expense_id UUID NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no >= 1 AND line_no <= 100),
  category_id UUID NOT NULL,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  description VARCHAR(300) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fleet_expense_lines_no UNIQUE (expense_id, line_no),
  CONSTRAINT fk_fleet_expense_lines_expense FOREIGN KEY (company_id, expense_id) REFERENCES fleet_expenses (company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_fleet_expense_lines_category FOREIGN KEY (company_id, category_id) REFERENCES fleet_expense_categories (company_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_fleet_expense_lines_expense ON fleet_expense_lines (company_id, expense_id);

ALTER TABLE fleet_expense_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_expense_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fleet_expense_lines_tenant_isolation ON fleet_expense_lines;
CREATE POLICY fleet_expense_lines_tenant_isolation ON fleet_expense_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON fleet_expense_lines TO an_app;
REVOKE ALL ON fleet_expense_lines FROM PUBLIC, anon, authenticated;
-- Lines are never edited. Deletion only happens through the parent (fleet_expenses rows are never deleted).
CREATE OR REPLACE FUNCTION fleet_expense_lines_immutable() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION 'fleet_expense_lines rows are immutable'; END; $f$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS fleet_expense_lines_no_change ON fleet_expense_lines;
CREATE TRIGGER fleet_expense_lines_no_change BEFORE UPDATE ON fleet_expense_lines FOR EACH ROW EXECUTE FUNCTION fleet_expense_lines_immutable();
