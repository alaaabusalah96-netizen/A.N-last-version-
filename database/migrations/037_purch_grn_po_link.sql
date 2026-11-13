-- Migration 037: Purchasing GRN to Purchase Order Link (AN-PURCH-GRN-PO-LINK-16)
-- Adds optional po_id to purch_grn and po_line_id to purch_grn_lines with SET NULL on delete.

-- 1. Add po_id to purch_grn
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purch_grn' AND column_name = 'po_id'
  ) THEN
    ALTER TABLE purch_grn
      ADD COLUMN po_id UUID NULL REFERENCES purch_purchase_orders(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_purch_grn_po
  ON purch_grn(company_id, po_id);

-- 2. Add po_line_id to purch_grn_lines
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purch_grn_lines' AND column_name = 'po_line_id'
  ) THEN
    ALTER TABLE purch_grn_lines
      ADD COLUMN po_line_id UUID NULL REFERENCES purch_po_lines(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_purch_grn_lines_po_line
  ON purch_grn_lines(po_line_id);
