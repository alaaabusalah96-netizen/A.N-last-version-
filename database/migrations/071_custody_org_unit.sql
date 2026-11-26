-- Migration 071: custody records belong to a company org unit (AN-ERP custody step E)
-- Additive and nullable: existing custody rows stay NULL = company level and are not changed.
-- Scope checks (user_org_scope: read / write / approve, with descendants) are enforced in the application layer.
ALTER TABLE custody_records ADD COLUMN IF NOT EXISTS org_unit_id UUID NULL REFERENCES org_units(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_custody_records_org_unit ON custody_records (company_id, org_unit_id);
