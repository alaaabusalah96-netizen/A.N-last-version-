-- Migration 050: Inventory Valuation Hardening & Complete Accounting/Sales/Purchasing Integration
-- Safe forward migration fixing schema/integrity gaps from Migration 049:
--   1) Column-scoped ON DELETE SET NULL on composite tenant FKs (zero NULL company_id risk)
--   2) FIFO transfer lineage columns & active layer remaining <= original constraint
--   3) Idempotency unique indexes on cost layers, valuation movements, cost adjustments, and opening valuations
--   4) Cost allocation composite FK to inv_cost_layers + Sales COGS idempotent linkage table (inv_sales_cogs_links)
--   5) Manual stock movement types ('adjustment', 'write_off', 'damage', 'internal_consumption', 'opening')
--   6) Immutable delivery cost snapshot columns & company_settings inventory adjustment / opening equity accounts
-- Zero EXCEPTION WHEN OTHERS; strict RLS + FORCE RLS for role an_app.

-- ============================================================================
-- 1. Fix composite FK on inv_valuation_reconciliations & enrich columns
-- ============================================================================
ALTER TABLE public.inv_valuation_reconciliations
  DROP CONSTRAINT IF EXISTS fk_inv_val_rec_wh;

ALTER TABLE public.inv_valuation_reconciliations
  ADD CONSTRAINT fk_inv_val_rec_wh
  FOREIGN KEY (warehouse_id, company_id)
  REFERENCES public.inv_warehouses (id, company_id)
  ON DELETE SET NULL (warehouse_id);

ALTER TABLE public.inv_valuation_reconciliations
  ADD COLUMN IF NOT EXISTS item_id UUID NULL,
  ADD COLUMN IF NOT EXISTS costing_method VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS account_id UUID NULL,
  ADD COLUMN IF NOT EXISTS unmatched_movements_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unbalanced_adjustments_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duplicate_journal_links_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_valuation_mismatches_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opening_diff NUMERIC(15, 4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS details JSONB NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL;

ALTER TABLE public.inv_valuation_reconciliations
  DROP CONSTRAINT IF EXISTS fk_inv_val_rec_item;

ALTER TABLE public.inv_valuation_reconciliations
  ADD CONSTRAINT fk_inv_val_rec_item
  FOREIGN KEY (item_id, company_id)
  REFERENCES public.inv_items (id, company_id)
  ON DELETE SET NULL (item_id);

ALTER TABLE public.inv_valuation_reconciliations
  DROP CONSTRAINT IF EXISTS fk_inv_val_rec_account;

ALTER TABLE public.inv_valuation_reconciliations
  ADD CONSTRAINT fk_inv_val_rec_account
  FOREIGN KEY (account_id, company_id)
  REFERENCES public.accounts (id, company_id)
  ON DELETE SET NULL (account_id);

-- ============================================================================
-- 2. Harden inv_cost_layers (remaining <= original, FIFO transfer lineage, idempotency)
-- ============================================================================
ALTER TABLE public.inv_cost_layers
  ADD COLUMN IF NOT EXISTS origin_layer_id UUID NULL,
  ADD COLUMN IF NOT EXISTS origin_source_type VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS origin_source_id UUID NULL,
  ADD COLUMN IF NOT EXISTS origin_source_line_id UUID NULL;

ALTER TABLE public.inv_cost_layers
  DROP CONSTRAINT IF EXISTS chk_inv_cost_layers_rem_le_orig;

ALTER TABLE public.inv_cost_layers
  ADD CONSTRAINT chk_inv_cost_layers_rem_le_orig
  CHECK (remaining_qty <= original_qty);

ALTER TABLE public.inv_cost_layers
  DROP CONSTRAINT IF EXISTS fk_inv_cost_layers_origin;

ALTER TABLE public.inv_cost_layers
  ADD CONSTRAINT fk_inv_cost_layers_origin
  FOREIGN KEY (origin_layer_id, company_id)
  REFERENCES public.inv_cost_layers (id, company_id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_inv_cost_layers_origin_source
  ON public.inv_cost_layers (company_id, origin_source_type, origin_source_id, origin_source_line_id);

CREATE INDEX IF NOT EXISTS idx_inv_cost_layers_source
  ON public.inv_cost_layers (company_id, source_type, source_id, source_line_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_cost_layers_idempotency
  ON public.inv_cost_layers (
    company_id,
    warehouse_id,
    item_id,
    source_type,
    source_id,
    COALESCE(source_line_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(origin_layer_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- ============================================================================
-- 3. Harden inv_valuation_movements (metadata & idempotency)
-- ============================================================================
ALTER TABLE public.inv_valuation_movements
  ADD COLUMN IF NOT EXISTS reason VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS cost_source VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS costing_method VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS reference_movement_id UUID NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL;

ALTER TABLE public.inv_valuation_movements
  DROP CONSTRAINT IF EXISTS fk_inv_val_mov_ref;

ALTER TABLE public.inv_valuation_movements
  ADD CONSTRAINT fk_inv_val_mov_ref
  FOREIGN KEY (reference_movement_id, company_id)
  REFERENCES public.inv_valuation_movements (id, company_id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_val_mov_idempotency
  ON public.inv_valuation_movements (
    company_id,
    warehouse_id,
    item_id,
    movement_type,
    source_type,
    source_id,
    COALESCE(source_line_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- ============================================================================
-- 4. Harden inv_cost_allocations composite FK to inv_cost_layers
-- ============================================================================
ALTER TABLE public.inv_cost_allocations
  DROP CONSTRAINT IF EXISTS fk_inv_cost_alloc_layer;

ALTER TABLE public.inv_cost_allocations
  ADD CONSTRAINT fk_inv_cost_alloc_layer
  FOREIGN KEY (cost_layer_id, company_id)
  REFERENCES public.inv_cost_layers (id, company_id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_inv_cost_alloc_layer
  ON public.inv_cost_allocations (company_id, cost_layer_id)
  WHERE cost_layer_id IS NOT NULL;

-- ============================================================================
-- 5. Harden inv_cost_adjustments (PPV metadata, lineage FKs & idempotency)
-- ============================================================================
ALTER TABLE public.inv_cost_adjustments
  ADD COLUMN IF NOT EXISTS source_line_id UUID NULL,
  ADD COLUMN IF NOT EXISTS grn_id UUID NULL,
  ADD COLUMN IF NOT EXISTS grn_line_id UUID NULL,
  ADD COLUMN IF NOT EXISTS invoice_id UUID NULL,
  ADD COLUMN IF NOT EXISTS invoice_line_id UUID NULL,
  ADD COLUMN IF NOT EXISTS cost_layer_id UUID NULL,
  ADD COLUMN IF NOT EXISTS costing_method VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS qty_basis NUMERIC(15, 4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS original_unit_cost NUMERIC(15, 4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS final_unit_cost NUMERIC(15, 4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS unit_variance NUMERIC(15, 4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS approved_by UUID NULL REFERENCES public.platform_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS created_by UUID NULL REFERENCES public.platform_users(id) ON DELETE SET NULL;

ALTER TABLE public.inv_cost_adjustments
  DROP CONSTRAINT IF EXISTS fk_inv_cost_adj_grn;
ALTER TABLE public.inv_cost_adjustments
  ADD CONSTRAINT fk_inv_cost_adj_grn
  FOREIGN KEY (grn_id, company_id)
  REFERENCES public.purch_grn (id, company_id)
  ON DELETE RESTRICT;

ALTER TABLE public.inv_cost_adjustments
  DROP CONSTRAINT IF EXISTS fk_inv_cost_adj_grn_line;
ALTER TABLE public.inv_cost_adjustments
  ADD CONSTRAINT fk_inv_cost_adj_grn_line
  FOREIGN KEY (grn_line_id, company_id)
  REFERENCES public.purch_grn_lines (id, company_id)
  ON DELETE RESTRICT;

ALTER TABLE public.inv_cost_adjustments
  DROP CONSTRAINT IF EXISTS fk_inv_cost_adj_invoice;
ALTER TABLE public.inv_cost_adjustments
  ADD CONSTRAINT fk_inv_cost_adj_invoice
  FOREIGN KEY (invoice_id, company_id)
  REFERENCES public.purch_supplier_invoices (id, company_id)
  ON DELETE RESTRICT;

ALTER TABLE public.inv_cost_adjustments
  DROP CONSTRAINT IF EXISTS fk_inv_cost_adj_invoice_line;
ALTER TABLE public.inv_cost_adjustments
  ADD CONSTRAINT fk_inv_cost_adj_invoice_line
  FOREIGN KEY (invoice_line_id, company_id)
  REFERENCES public.purch_supplier_invoice_lines (id, company_id)
  ON DELETE RESTRICT;

ALTER TABLE public.inv_cost_adjustments
  DROP CONSTRAINT IF EXISTS fk_inv_cost_adj_layer;
ALTER TABLE public.inv_cost_adjustments
  ADD CONSTRAINT fk_inv_cost_adj_layer
  FOREIGN KEY (cost_layer_id, company_id)
  REFERENCES public.inv_cost_layers (id, company_id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_cost_adj_idempotency
  ON public.inv_cost_adjustments (
    company_id,
    source_type,
    source_id,
    COALESCE(source_line_id, '00000000-0000-0000-0000-000000000000'::uuid),
    warehouse_id,
    item_id,
    COALESCE(cost_layer_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- ============================================================================
-- 6. Harden inv_opening_valuations (auditability, approval, movement link)
-- ============================================================================
ALTER TABLE public.inv_opening_valuations
  ADD COLUMN IF NOT EXISTS costing_method VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS evidence_ref VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS created_by UUID NULL REFERENCES public.platform_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_by UUID NULL REFERENCES public.platform_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS valuation_movement_id UUID NULL;

ALTER TABLE public.inv_opening_valuations
  DROP CONSTRAINT IF EXISTS fk_inv_opening_val_mov;

ALTER TABLE public.inv_opening_valuations
  ADD CONSTRAINT fk_inv_opening_val_mov
  FOREIGN KEY (valuation_movement_id, company_id)
  REFERENCES public.inv_valuation_movements (id, company_id)
  ON DELETE SET NULL (valuation_movement_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_opening_approved_wh_item
  ON public.inv_opening_valuations (company_id, warehouse_id, item_id)
  WHERE status = 'approved';

-- ============================================================================
-- 7. Extend inv_stock_movements types & sales snapshot/COGS linkage
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
    'adjustment',
    'write_off',
    'damage',
    'internal_consumption',
    'opening'
  ));

ALTER TABLE public.sales_delivery_lines
  ADD COLUMN IF NOT EXISTS frozen_total_cost NUMERIC(15, 4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS valuation_movement_id UUID NULL;

ALTER TABLE public.sales_delivery_lines
  DROP CONSTRAINT IF EXISTS fk_sales_delivery_lines_val_mov;

ALTER TABLE public.sales_delivery_lines
  ADD CONSTRAINT fk_sales_delivery_lines_val_mov
  FOREIGN KEY (valuation_movement_id, company_id)
  REFERENCES public.inv_valuation_movements (id, company_id)
  ON DELETE SET NULL (valuation_movement_id);

ALTER TABLE public.sales_invoices
  ADD COLUMN IF NOT EXISTS cogs_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS cogs_posted_at TIMESTAMPTZ NULL;

ALTER TABLE public.sales_invoice_lines
  ADD COLUMN IF NOT EXISTS cogs_cost NUMERIC(15, 2) NOT NULL DEFAULT 0.00;

-- ============================================================================
-- 8. Sales COGS Idempotent Link Table (blocks duplicate COGS consumption)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.inv_sales_cogs_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL,
  invoice_line_id UUID NOT NULL,
  delivery_line_id UUID NOT NULL,
  valuation_movement_id UUID NULL,
  invoiced_qty NUMERIC(15, 4) NOT NULL CHECK (invoiced_qty > 0),
  cogs_amount NUMERIC(15, 2) NOT NULL CHECK (cogs_amount >= 0),
  journal_entry_id UUID NULL REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inv_sales_cogs_links_invoice_line UNIQUE (company_id, invoice_line_id),
  CONSTRAINT fk_inv_sales_cogs_inv FOREIGN KEY (invoice_id, company_id) REFERENCES public.sales_invoices(id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_sales_cogs_inv_line FOREIGN KEY (invoice_line_id, company_id) REFERENCES public.sales_invoice_lines(id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_sales_cogs_del_line FOREIGN KEY (delivery_line_id, company_id) REFERENCES public.sales_delivery_lines(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inv_sales_cogs_val_mov FOREIGN KEY (valuation_movement_id, company_id) REFERENCES public.inv_valuation_movements(id, company_id) ON DELETE SET NULL (valuation_movement_id)
);

CREATE INDEX IF NOT EXISTS idx_inv_sales_cogs_links_delivery
  ON public.inv_sales_cogs_links (company_id, delivery_line_id);

ALTER TABLE public.inv_sales_cogs_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_sales_cogs_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inv_sales_cogs_links_tenant_isolation ON public.inv_sales_cogs_links;
CREATE POLICY inv_sales_cogs_links_tenant_isolation ON public.inv_sales_cogs_links
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inv_sales_cogs_links TO an_app;
REVOKE ALL ON public.inv_sales_cogs_links FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 9. Company Settings Accounts for Manual Inventory Adjustments & Opening Equity
-- ============================================================================
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS inventory_adjustment_account_id UUID NULL,
  ADD COLUMN IF NOT EXISTS opening_balance_equity_account_id UUID NULL;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS fk_company_settings_inv_adj_account;

ALTER TABLE public.company_settings
  ADD CONSTRAINT fk_company_settings_inv_adj_account
  FOREIGN KEY (inventory_adjustment_account_id, company_id)
  REFERENCES public.accounts (id, company_id)
  ON DELETE SET NULL (inventory_adjustment_account_id);

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS fk_company_settings_opening_equity_account;

ALTER TABLE public.company_settings
  ADD CONSTRAINT fk_company_settings_opening_equity_account
  FOREIGN KEY (opening_balance_equity_account_id, company_id)
  REFERENCES public.accounts (id, company_id)
  ON DELETE SET NULL (opening_balance_equity_account_id);
