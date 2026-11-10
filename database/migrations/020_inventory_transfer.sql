-- Migration 020: Inventory Transfer support
-- Extends inv_stock_movements with transfer_id and updates movement_type CHECK constraint

ALTER TABLE inv_stock_movements DROP CONSTRAINT IF EXISTS inv_stock_movements_movement_type_check;

ALTER TABLE inv_stock_movements ADD CONSTRAINT inv_stock_movements_movement_type_check 
  CHECK (movement_type IN ('receive', 'issue', 'transfer_out', 'transfer_in', 'transfer'));

ALTER TABLE inv_stock_movements ADD COLUMN IF NOT EXISTS transfer_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_inv_stock_movements_transfer ON inv_stock_movements(company_id, transfer_id);
