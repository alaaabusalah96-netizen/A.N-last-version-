-- Migration 023: Inventory & Purchasing Composite Foreign Keys (Data Integrity Hardening)
-- Enforces tenant isolation integrity at the database level for inventory and purchasing tables
-- preventing cross-tenant warehouse, item, supplier, and GRN contamination.

-- 1. Pre-migration orphan & cross-company mismatch check
DO $$
DECLARE
  orphan_count INT;
BEGIN
  -- inv_stock_balances vs inv_warehouses
  SELECT COUNT(*) INTO orphan_count
  FROM inv_stock_balances b
  LEFT JOIN inv_warehouses w ON b.warehouse_id = w.id
  WHERE w.id IS NULL OR b.company_id <> w.company_id;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 023 ABORTED: Found % inv_stock_balances with mismatched warehouse reference!', orphan_count;
  END IF;

  -- inv_stock_balances vs inv_items
  SELECT COUNT(*) INTO orphan_count
  FROM inv_stock_balances b
  LEFT JOIN inv_items i ON b.item_id = i.id
  WHERE i.id IS NULL OR b.company_id <> i.company_id;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 023 ABORTED: Found % inv_stock_balances with mismatched item reference!', orphan_count;
  END IF;

  -- inv_stock_movements vs inv_warehouses
  SELECT COUNT(*) INTO orphan_count
  FROM inv_stock_movements m
  LEFT JOIN inv_warehouses w ON m.warehouse_id = w.id
  WHERE w.id IS NULL OR m.company_id <> w.company_id;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 023 ABORTED: Found % inv_stock_movements with mismatched warehouse reference!', orphan_count;
  END IF;

  -- inv_stock_movements vs inv_items
  SELECT COUNT(*) INTO orphan_count
  FROM inv_stock_movements m
  LEFT JOIN inv_items i ON m.item_id = i.id
  WHERE i.id IS NULL OR m.company_id <> i.company_id;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 023 ABORTED: Found % inv_stock_movements with mismatched item reference!', orphan_count;
  END IF;

  -- purch_grn vs purch_suppliers
  SELECT COUNT(*) INTO orphan_count
  FROM purch_grn g
  LEFT JOIN purch_suppliers s ON g.supplier_id = s.id
  WHERE s.id IS NULL OR g.company_id <> s.company_id;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 023 ABORTED: Found % purch_grn with mismatched supplier reference!', orphan_count;
  END IF;

  -- purch_grn vs inv_warehouses
  SELECT COUNT(*) INTO orphan_count
  FROM purch_grn g
  LEFT JOIN inv_warehouses w ON g.warehouse_id = w.id
  WHERE w.id IS NULL OR g.company_id <> w.company_id;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 023 ABORTED: Found % purch_grn with mismatched warehouse reference!', orphan_count;
  END IF;

  -- purch_grn_lines vs purch_grn
  SELECT COUNT(*) INTO orphan_count
  FROM purch_grn_lines l
  LEFT JOIN purch_grn g ON l.grn_id = g.id
  WHERE g.id IS NULL OR l.company_id <> g.company_id;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 023 ABORTED: Found % purch_grn_lines with mismatched grn reference!', orphan_count;
  END IF;

  -- purch_grn_lines vs inv_items
  SELECT COUNT(*) INTO orphan_count
  FROM purch_grn_lines l
  LEFT JOIN inv_items i ON l.item_id = i.id
  WHERE i.id IS NULL OR l.company_id <> i.company_id;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 023 ABORTED: Found % purch_grn_lines with mismatched item reference!', orphan_count;
  END IF;
END $$;

-- 2. Add composite UNIQUE constraints on parent tables
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_inv_warehouses_company_id_id'
  ) THEN
    ALTER TABLE inv_warehouses ADD CONSTRAINT uq_inv_warehouses_company_id_id UNIQUE (company_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_inv_items_company_id_id'
  ) THEN
    ALTER TABLE inv_items ADD CONSTRAINT uq_inv_items_company_id_id UNIQUE (company_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_purch_suppliers_company_id_id'
  ) THEN
    ALTER TABLE purch_suppliers ADD CONSTRAINT uq_purch_suppliers_company_id_id UNIQUE (company_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_purch_grn_company_id_id'
  ) THEN
    ALTER TABLE purch_grn ADD CONSTRAINT uq_purch_grn_company_id_id UNIQUE (company_id, id);
  END IF;
END $$;

-- 3. Drop old single-column foreign key constraints on inventory and purchasing child tables if present
ALTER TABLE inv_stock_balances DROP CONSTRAINT IF EXISTS inv_stock_balances_warehouse_id_fkey;
ALTER TABLE inv_stock_balances DROP CONSTRAINT IF EXISTS inv_stock_balances_item_id_fkey;

ALTER TABLE inv_stock_movements DROP CONSTRAINT IF EXISTS inv_stock_movements_warehouse_id_fkey;
ALTER TABLE inv_stock_movements DROP CONSTRAINT IF EXISTS inv_stock_movements_item_id_fkey;

ALTER TABLE purch_grn DROP CONSTRAINT IF EXISTS purch_grn_supplier_id_fkey;
ALTER TABLE purch_grn DROP CONSTRAINT IF EXISTS purch_grn_warehouse_id_fkey;

ALTER TABLE purch_grn_lines DROP CONSTRAINT IF EXISTS purch_grn_lines_grn_id_fkey;
ALTER TABLE purch_grn_lines DROP CONSTRAINT IF EXISTS purch_grn_lines_item_id_fkey;

-- 4. Add composite FOREIGN KEY constraints
DO $$
BEGIN
  -- inv_stock_balances
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_balances_warehouse_company') THEN
    ALTER TABLE inv_stock_balances 
      ADD CONSTRAINT fk_inv_stock_balances_warehouse_company 
      FOREIGN KEY (warehouse_id, company_id) 
      REFERENCES inv_warehouses (id, company_id) 
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_balances_item_company') THEN
    ALTER TABLE inv_stock_balances 
      ADD CONSTRAINT fk_inv_stock_balances_item_company 
      FOREIGN KEY (item_id, company_id) 
      REFERENCES inv_items (id, company_id) 
      ON DELETE RESTRICT;
  END IF;

  -- inv_stock_movements
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_movements_warehouse_company') THEN
    ALTER TABLE inv_stock_movements 
      ADD CONSTRAINT fk_inv_stock_movements_warehouse_company 
      FOREIGN KEY (warehouse_id, company_id) 
      REFERENCES inv_warehouses (id, company_id) 
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_movements_item_company') THEN
    ALTER TABLE inv_stock_movements 
      ADD CONSTRAINT fk_inv_stock_movements_item_company 
      FOREIGN KEY (item_id, company_id) 
      REFERENCES inv_items (id, company_id) 
      ON DELETE RESTRICT;
  END IF;

  -- purch_grn
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purch_grn_supplier_company') THEN
    ALTER TABLE purch_grn 
      ADD CONSTRAINT fk_purch_grn_supplier_company 
      FOREIGN KEY (supplier_id, company_id) 
      REFERENCES purch_suppliers (id, company_id) 
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purch_grn_warehouse_company') THEN
    ALTER TABLE purch_grn 
      ADD CONSTRAINT fk_purch_grn_warehouse_company 
      FOREIGN KEY (warehouse_id, company_id) 
      REFERENCES inv_warehouses (id, company_id) 
      ON DELETE RESTRICT;
  END IF;

  -- purch_grn_lines
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purch_grn_lines_grn_company') THEN
    ALTER TABLE purch_grn_lines 
      ADD CONSTRAINT fk_purch_grn_lines_grn_company 
      FOREIGN KEY (grn_id, company_id) 
      REFERENCES purch_grn (id, company_id) 
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purch_grn_lines_item_company') THEN
    ALTER TABLE purch_grn_lines 
      ADD CONSTRAINT fk_purch_grn_lines_item_company 
      FOREIGN KEY (item_id, company_id) 
      REFERENCES inv_items (id, company_id) 
      ON DELETE RESTRICT;
  END IF;
END $$;
