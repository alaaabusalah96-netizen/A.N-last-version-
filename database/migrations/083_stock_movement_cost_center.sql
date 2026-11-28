-- ==============================================================================
-- Migration 083: Cost center on stock issue movements (additive)
-- Nullable cost_center_id on inv_stock_movements, set only for issues charged to a cost center.
-- Existing rows stay NULL. The cost center must be an org_units row of the same company
-- (composite FK); the service additionally requires unit_type = 'cost_center' and active.
-- Rollback: ALTER TABLE inv_stock_movements DROP COLUMN cost_center_id; and delete the 083 row from schema_migrations.
-- ==============================================================================
ALTER TABLE inv_stock_movements ADD COLUMN IF NOT EXISTS cost_center_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_movements_cost_center') THEN
    ALTER TABLE inv_stock_movements
      ADD CONSTRAINT fk_inv_stock_movements_cost_center
      FOREIGN KEY (company_id, cost_center_id) REFERENCES org_units (company_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inv_stock_movements_cost_center
  ON inv_stock_movements (company_id, cost_center_id, created_at DESC) WHERE cost_center_id IS NOT NULL;
