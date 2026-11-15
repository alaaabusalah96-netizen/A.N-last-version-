-- Migration 042: Supplier Invoice Quantity & Concurrency Guards (AN-FIX-INVOICE-P0-1)
-- Enforces:
-- 1) No duplicate grn_line_id within the same supplier invoice: UNIQUE (company_id, invoice_id, grn_line_id)
-- 2) Database-level FOR UPDATE lock on purch_grn_lines & cumulative posted qty check on transition to 'posted'
-- 3) Prevents altering lines of an already-posted supplier invoice

-- 1. Pre-check existing invoice lines for duplicate (company_id, invoice_id, grn_line_id)
DO $$
DECLARE
  v_dup_count INTEGER;
BEGIN
  SELECT count(*) INTO v_dup_count
  FROM (
    SELECT company_id, invoice_id, grn_line_id
    FROM purch_supplier_invoice_lines
    GROUP BY company_id, invoice_id, grn_line_id
    HAVING count(*) > 1
  ) dup;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION 'DUPLICATE_INVOICE_GRN_LINE: % duplicate (company_id, invoice_id, grn_line_id) groups exist in purch_supplier_invoice_lines. Clean data before applying 042.', v_dup_count;
  END IF;
END $$;

-- 2. Unique constraint preventing duplicate grn_line_id per invoice
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'purch_supplier_invoice_lines'
      AND constraint_type = 'UNIQUE'
      AND constraint_name = 'uq_purch_supplier_invoice_lines_company_invoice_grn_line'
  ) THEN
    ALTER TABLE purch_supplier_invoice_lines
      ADD CONSTRAINT uq_purch_supplier_invoice_lines_company_invoice_grn_line
      UNIQUE (company_id, invoice_id, grn_line_id);
  END IF;
END $$;

-- 3. Trigger function enforcing cumulative posted qty <= grn_line qty under FOR UPDATE lock
CREATE OR REPLACE FUNCTION trg_fn_purch_supplier_invoice_qty_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  rec RECORD;
  v_grn_qty NUMERIC(15, 4);
  v_grn_status VARCHAR(20);
  v_posted_qty NUMERIC(15, 4);
  v_line_count INTEGER := 0;
BEGIN
  IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'posted') THEN
    FOR rec IN
      SELECT
        sil.grn_line_id,
        SUM(sil.qty) AS line_qty
      FROM purch_supplier_invoice_lines sil
      WHERE sil.company_id = NEW.company_id
        AND sil.invoice_id = NEW.id
      GROUP BY sil.grn_line_id
      ORDER BY sil.grn_line_id ASC
    LOOP
      v_line_count := v_line_count + 1;

      SELECT gl.qty, g.status
        INTO v_grn_qty, v_grn_status
      FROM purch_grn_lines gl
      INNER JOIN purch_grn g
        ON g.id = gl.grn_id AND g.company_id = gl.company_id
      WHERE gl.company_id = NEW.company_id
        AND gl.id = rec.grn_line_id
      FOR UPDATE OF gl;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'GRN_LINE_NOT_FOUND: Referenced GRN line % does not exist for company %.', rec.grn_line_id, NEW.company_id;
      END IF;

      IF v_grn_status <> 'posted' THEN
        RAISE EXCEPTION 'GRN_LINE_NOT_POSTED: GRN line % belongs to GRN with status %, must be posted.', rec.grn_line_id, v_grn_status;
      END IF;

      SELECT COALESCE(SUM(sil2.qty), 0)
        INTO v_posted_qty
      FROM purch_supplier_invoice_lines sil2
      INNER JOIN purch_supplier_invoices si2
        ON si2.id = sil2.invoice_id AND si2.company_id = sil2.company_id
      WHERE sil2.company_id = NEW.company_id
        AND sil2.grn_line_id = rec.grn_line_id
        AND si2.status = 'posted'
        AND si2.id <> NEW.id;

      IF (v_posted_qty + rec.line_qty) > v_grn_qty THEN
        RAISE EXCEPTION 'OVER_INVOICED_GRN_LINE: Total invoiced quantity (% + %) exceeds GRN line quantity (%) for grn_line_id %.', v_posted_qty, rec.line_qty, v_grn_qty, rec.grn_line_id;
      END IF;
    END LOOP;

    IF v_line_count = 0 THEN
      RAISE EXCEPTION 'EMPTY_SUPPLIER_INVOICE: Cannot post supplier invoice % with no lines.', NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purch_supplier_invoice_qty_guard ON purch_supplier_invoices;
CREATE TRIGGER trg_purch_supplier_invoice_qty_guard
  BEFORE INSERT OR UPDATE ON purch_supplier_invoices
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_purch_supplier_invoice_qty_guard();

-- 4. Guard against inserting or updating lines belonging to an already-posted supplier invoice
CREATE OR REPLACE FUNCTION trg_fn_purch_supplier_invoice_lines_posted_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status VARCHAR(20);
BEGIN
  SELECT status INTO v_status
  FROM purch_supplier_invoices
  WHERE company_id = NEW.company_id AND id = NEW.invoice_id;

  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_SUPPLIER_INVOICE_LINES: Cannot insert or update lines of posted supplier invoice %.', NEW.invoice_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purch_supplier_invoice_lines_posted_guard ON purch_supplier_invoice_lines;
CREATE TRIGGER trg_purch_supplier_invoice_lines_posted_guard
  BEFORE INSERT OR UPDATE ON purch_supplier_invoice_lines
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_purch_supplier_invoice_lines_posted_guard();

REVOKE EXECUTE ON FUNCTION public.trg_fn_purch_supplier_invoice_qty_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_fn_purch_supplier_invoice_lines_posted_guard() FROM PUBLIC, anon, authenticated;
