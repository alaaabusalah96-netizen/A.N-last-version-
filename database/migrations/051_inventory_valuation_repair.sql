-- Migration 051: Inventory Valuation Repair (REPAIR-4)
-- Forward-only migration adding Moving Average source attribution provenance,
-- sales COGS forward-only audit reversals, reconciliation scope metadata,
-- strict composite foreign keys, RLS, FORCE RLS, and least-privilege role permissions.

-- ============================================================================
-- 1. Pre-constraint data integrity check DO block
-- ============================================================================
DO $$
BEGIN
  -- Verify no existing negative remaining inventory in cost layers
  IF EXISTS (
    SELECT 1 FROM public.inv_cost_layers WHERE remaining_qty < 0 OR original_qty < 0 OR remaining_qty > original_qty
  ) THEN
    RAISE EXCEPTION 'MIGRATION_ABORTED: Found invalid or negative remaining_qty in inv_cost_layers.';
  END IF;

  -- Verify no negative quantities in existing valuation movements
  IF EXISTS (
    SELECT 1 FROM public.inv_valuation_movements WHERE qty < 0 OR total_cost < 0
  ) THEN
    RAISE EXCEPTION 'MIGRATION_ABORTED: Found negative quantities or totals in inv_valuation_movements.';
  END IF;
END $$;

-- ============================================================================
-- 2. Moving Average Source Attribution Ledger (inv_ma_source_balances)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.inv_ma_source_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  item_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  grn_id UUID NOT NULL,
  grn_line_id UUID NOT NULL,
  received_qty NUMERIC(15,4) NOT NULL CHECK (received_qty >= 0),
  remaining_qty NUMERIC(15,4) NOT NULL CHECK (remaining_qty >= 0),
  consumed_qty NUMERIC(15,4) NOT NULL CHECK (consumed_qty >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_inv_ma_src_bal_sum CHECK (remaining_qty + consumed_qty = received_qty),
  CONSTRAINT uq_inv_ma_src_bal UNIQUE (company_id, warehouse_id, item_id, grn_line_id),
  CONSTRAINT fk_inv_ma_src_bal_wh FOREIGN KEY (warehouse_id, company_id) REFERENCES public.inv_warehouses(id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_ma_src_bal_item FOREIGN KEY (item_id, company_id) REFERENCES public.inv_items(id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_ma_src_bal_grn FOREIGN KEY (grn_id, company_id) REFERENCES public.purch_grn(id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_ma_src_bal_grn_line FOREIGN KEY (grn_line_id, company_id) REFERENCES public.purch_grn_lines(id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inv_ma_src_bal_wh_item
  ON public.inv_ma_source_balances (company_id, item_id, warehouse_id);

CREATE INDEX IF NOT EXISTS idx_inv_ma_src_bal_grn_line
  ON public.inv_ma_source_balances (company_id, grn_line_id);

ALTER TABLE public.inv_ma_source_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_ma_source_balances FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inv_ma_source_balances_tenant_isolation ON public.inv_ma_source_balances;
CREATE POLICY inv_ma_source_balances_tenant_isolation ON public.inv_ma_source_balances
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON public.inv_ma_source_balances TO an_app;
REVOKE ALL ON public.inv_ma_source_balances FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 3. Moving Average Source Attribution Event Ledger (inv_ma_source_events)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.inv_ma_source_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  item_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  grn_id UUID NOT NULL,
  grn_line_id UUID NOT NULL,
  event_type VARCHAR(30) NOT NULL CHECK (event_type IN ('RECEIPT','ISSUE','TRANSFER_OUT','TRANSFER_IN','PURCHASE_RETURN','PPV')),
  quantity NUMERIC(15,4) NOT NULL CHECK (quantity > 0),
  reference_movement_id UUID NULL,
  source_id UUID NOT NULL,
  source_line_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_inv_ma_src_ev_wh FOREIGN KEY (warehouse_id, company_id) REFERENCES public.inv_warehouses(id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_ma_src_ev_item FOREIGN KEY (item_id, company_id) REFERENCES public.inv_items(id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_ma_src_ev_grn FOREIGN KEY (grn_id, company_id) REFERENCES public.purch_grn(id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_ma_src_ev_grn_line FOREIGN KEY (grn_line_id, company_id) REFERENCES public.purch_grn_lines(id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_ma_src_ev_mov FOREIGN KEY (reference_movement_id, company_id) REFERENCES public.inv_valuation_movements(id, company_id) ON DELETE SET NULL (reference_movement_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_ma_src_ev_idempotency
  ON public.inv_ma_source_events (
    company_id,
    event_type,
    warehouse_id,
    item_id,
    grn_line_id,
    source_id,
    COALESCE(source_line_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS idx_inv_ma_src_ev_grn_line
  ON public.inv_ma_source_events (company_id, grn_line_id);

ALTER TABLE public.inv_ma_source_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_ma_source_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inv_ma_source_events_tenant_isolation ON public.inv_ma_source_events;
CREATE POLICY inv_ma_source_events_tenant_isolation ON public.inv_ma_source_events
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON public.inv_ma_source_events TO an_app;
REVOKE ALL ON public.inv_ma_source_events FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 4. Audited Forward-Only Sales COGS Reversals (inv_sales_cogs_reversals)
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_inv_sales_cogs_links_id_comp'
  ) THEN
    ALTER TABLE public.inv_sales_cogs_links
      ADD CONSTRAINT uq_inv_sales_cogs_links_id_comp UNIQUE (id, company_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.inv_sales_cogs_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  original_cogs_link_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  invoice_line_id UUID NOT NULL,
  delivery_line_id UUID NOT NULL,
  reversed_qty NUMERIC(15,4) NOT NULL CHECK (reversed_qty > 0),
  reversed_cogs_amount NUMERIC(15,2) NOT NULL CHECK (reversed_cogs_amount >= 0),
  reason TEXT NOT NULL,
  reversal_journal_entry_id UUID NULL REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES public.platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inv_cogs_rev_orig UNIQUE (company_id, original_cogs_link_id),
  CONSTRAINT fk_inv_cogs_rev_link FOREIGN KEY (original_cogs_link_id, company_id) REFERENCES public.inv_sales_cogs_links(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inv_cogs_rev_inv FOREIGN KEY (invoice_id, company_id) REFERENCES public.sales_invoices(id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_cogs_rev_inv_line FOREIGN KEY (invoice_line_id, company_id) REFERENCES public.sales_invoice_lines(id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_cogs_rev_del_line FOREIGN KEY (delivery_line_id, company_id) REFERENCES public.sales_delivery_lines(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inv_cogs_rev_je FOREIGN KEY (reversal_journal_entry_id, company_id) REFERENCES public.journal_entries(id, company_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_inv_cogs_rev_delivery
  ON public.inv_sales_cogs_reversals (company_id, delivery_line_id);

ALTER TABLE public.inv_sales_cogs_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_sales_cogs_reversals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inv_sales_cogs_reversals_tenant_isolation ON public.inv_sales_cogs_reversals;
CREATE POLICY inv_sales_cogs_reversals_tenant_isolation ON public.inv_sales_cogs_reversals
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON public.inv_sales_cogs_reversals TO an_app;
REVOKE ALL ON public.inv_sales_cogs_reversals FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 5. Reconciliation Scope Metadata & Status Constraint Extension
-- ============================================================================
ALTER TABLE public.inv_valuation_reconciliations
  ADD COLUMN IF NOT EXISTS comparison_scope VARCHAR(30) NOT NULL DEFAULT 'COMPANY_GL'
    CHECK (comparison_scope IN ('COMPANY_GL', 'SUBLEDGER_ONLY', 'HISTORICAL_GL')),
  ADD COLUMN IF NOT EXISTS is_gl_comparable BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.inv_valuation_reconciliations
  DROP CONSTRAINT IF EXISTS inv_valuation_reconciliations_status_check;

ALTER TABLE public.inv_valuation_reconciliations
  ADD CONSTRAINT inv_valuation_reconciliations_status_check
  CHECK (status IN ('reconciled', 'discrepancy_detected', 'subledger_only', 'historical_unavailable'));
