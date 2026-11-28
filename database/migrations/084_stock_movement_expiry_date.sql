-- ==============================================================================
-- Migration 084: Optional expiry date on stock receipt movements (additive)
-- Nullable expiry_date on inv_stock_movements, set only for receipts that carry an expiry date.
-- Existing rows stay NULL (shown as "بدون تاريخ صلاحية"). Dates only: no lot or FEFO tracking.
-- Rollback: ALTER TABLE inv_stock_movements DROP COLUMN expiry_date; and delete the 084 row from schema_migrations.
-- ==============================================================================
ALTER TABLE inv_stock_movements ADD COLUMN IF NOT EXISTS expiry_date DATE NULL;

CREATE INDEX IF NOT EXISTS idx_inv_stock_movements_expiry
  ON inv_stock_movements (company_id, expiry_date) WHERE expiry_date IS NOT NULL;
