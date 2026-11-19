-- Migration 054: Sales Returns & Sales Invoice Cancellation (Package 7B)
-- Forward-only migration introducing:
--   1) 'sales_return' stock movement type and 'SALES_RETURN' MA source event type
--   2) Audit-safe cancellation columns on sales_invoices (no deletion of posted invoices)
--   3) sales_returns and sales_return_lines tables with strict composite tenant FKs,
--      posted-line trigger guard, RLS + FORCE RLS, and least-privilege grants for an_app.
-- Zero EXCEPTION WHEN OTHERS.

-- ============================================================================
-- 1. Extend inv_stock_movements & inv_ma_source_events check constraints
-- ============================================================================
ALTER TABLE public.inv_stock_movements
  DROP CONSTRAINT IF EXISTS inv_stock_movements_movement_type_check;

ALTER TABLE public.inv_stock_movements
  ADD CONSTRAINT inv_stock_movements_movement_type_check
  CHECK (movement_type IN (
    'receive',
    'issue',
    'transfer_out',
    'transfer_in',
    'transfer',
    'purchase_return',
    'sales_delivery',
    'sales_return',
    'adjustment',
    'write_off',
    'damage',
    'internal_consumption',
    'opening'
  ));

ALTER TABLE public.inv_ma_source_events
  DROP CONSTRAINT IF EXISTS inv_ma_source_events_event_type_check;

ALTER TABLE public.inv_ma_source_events
  ADD CONSTRAINT inv_ma_source_events_event_type_check
  CHECK (event_type IN (
    'OPENING',
    'RECEIPT',
    'ISSUE',
    'TRANSFER_OUT',
    'TRANSFER_IN',
    'PURCHASE_RETURN',
    'PPV',
    'SALES_RETURN'
  ));

-- ============================================================================
-- 2. Extend sales_invoices for posted invoice cancellation
-- ============================================================================
ALTER TABLE public.sales_invoices
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID NULL REFERENCES public.platform_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id UUID NULL;

ALTER TABLE public.sales_invoices
  DROP CONSTRAINT IF EXISTS fk_sales_invoices_reversal_je;

ALTER TABLE public.sales_invoices
  ADD CONSTRAINT fk_sales_invoices_reversal_je
  FOREIGN KEY (reversal_journal_entry_id, company_id)
  REFERENCES public.journal_entries (id, company_id)
  ON DELETE SET NULL (reversal_journal_entry_id);

-- ============================================================================
-- 3. Create sales_returns & sales_return_lines tables
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.sales_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  return_no VARCHAR(50) NULL,
  return_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  subtotal NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (subtotal >= 0),
  tax_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (tax_amount >= 0),
  total_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (total_amount >= 0),
  cogs_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (cogs_amount >= 0),
  reason TEXT NULL,
  memo TEXT NULL,
  journal_entry_id UUID NULL,
  posted_at TIMESTAMPTZ NULL,
  posted_by UUID NULL REFERENCES public.platform_users(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES public.platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sales_returns_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_sales_returns_customer
    FOREIGN KEY (customer_id, company_id)
    REFERENCES public.sales_customers (id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_sales_returns_invoice
    FOREIGN KEY (invoice_id, company_id)
    REFERENCES public.sales_invoices (id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_sales_returns_warehouse
    FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.inv_warehouses (id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_sales_returns_journal_entry
    FOREIGN KEY (journal_entry_id, company_id)
    REFERENCES public.journal_entries (id, company_id)
    ON DELETE SET NULL (journal_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_returns_company
  ON public.sales_returns (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_returns_invoice
  ON public.sales_returns (company_id, invoice_id);

CREATE INDEX IF NOT EXISTS idx_sales_returns_customer
  ON public.sales_returns (company_id, customer_id);

CREATE TABLE IF NOT EXISTS public.sales_return_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_line_id UUID NOT NULL,
  delivery_line_id UUID NULL,
  item_id UUID NOT NULL,
  qty NUMERIC(15, 4) NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  tax_rate NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
  tax_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (tax_amount >= 0),
  line_total NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (line_total >= 0),
  cogs_cost NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (cogs_cost >= 0),
  valuation_movement_id UUID NULL,
  line_no INT NOT NULL DEFAULT 1,
  CONSTRAINT uq_sales_return_lines_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_sales_return_lines_return
    FOREIGN KEY (return_id, company_id)
    REFERENCES public.sales_returns (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_sales_return_lines_inv_line
    FOREIGN KEY (invoice_line_id, company_id)
    REFERENCES public.sales_invoice_lines (id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_sales_return_lines_del_line
    FOREIGN KEY (delivery_line_id, company_id)
    REFERENCES public.sales_delivery_lines (id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_sales_return_lines_item
    FOREIGN KEY (item_id, company_id)
    REFERENCES public.inv_items (id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_sales_return_lines_val_mov
    FOREIGN KEY (valuation_movement_id, company_id)
    REFERENCES public.inv_valuation_movements (id, company_id)
    ON DELETE SET NULL (valuation_movement_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_return_lines_return
  ON public.sales_return_lines (return_id);

CREATE INDEX IF NOT EXISTS idx_sales_return_lines_inv_line
  ON public.sales_return_lines (company_id, invoice_line_id);

-- ============================================================================
-- 4. Trigger guard preventing mutations on lines of posted sales returns
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_fn_sales_return_lines_posted_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status VARCHAR(20);
BEGIN
  SELECT status INTO v_status
  FROM public.sales_returns
  WHERE company_id = NEW.company_id AND id = NEW.return_id;

  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'CANNOT_MODIFY_POSTED_SALES_RETURN_LINES: Cannot insert or update lines of posted sales return %.', NEW.return_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_return_lines_posted_guard ON public.sales_return_lines;
CREATE TRIGGER trg_sales_return_lines_posted_guard
  BEFORE INSERT OR UPDATE ON public.sales_return_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_sales_return_lines_posted_guard();

-- ============================================================================
-- 5. Enable & Force RLS + least-privilege grants for an_app
-- ============================================================================
ALTER TABLE public.sales_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_returns FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sales_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_return_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sales_returns_tenant_isolation ON public.sales_returns;
CREATE POLICY sales_returns_tenant_isolation ON public.sales_returns
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS sales_return_lines_tenant_isolation ON public.sales_return_lines;
CREATE POLICY sales_return_lines_tenant_isolation ON public.sales_return_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_returns TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_return_lines TO an_app;

REVOKE ALL ON public.sales_returns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sales_return_lines FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.trg_fn_sales_return_lines_posted_guard() FROM PUBLIC, anon, authenticated;
