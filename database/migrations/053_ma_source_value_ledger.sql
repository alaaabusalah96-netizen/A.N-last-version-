-- Migration 053: Moving Average Source Value Ledger (Package 7A)
-- Forward-only migration extending inv_ma_source_balances and inv_ma_source_events
-- beyond GRN-only provenance to track all receipt/opening/transfer/issue sources
-- with exact financial value conservation and root origin lineage.
-- Zero EXCEPTION WHEN OTHERS; strict RLS + FORCE RLS + least-privilege for an_app.

-- ============================================================================
-- 1. Extend inv_ma_source_balances for general sources, origin lineage & values
-- ============================================================================
ALTER TABLE public.inv_ma_source_balances
  ALTER COLUMN grn_id DROP NOT NULL,
  ALTER COLUMN grn_line_id DROP NOT NULL;

ALTER TABLE public.inv_ma_source_balances
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS source_id UUID,
  ADD COLUMN IF NOT EXISTS source_line_id UUID NULL,
  ADD COLUMN IF NOT EXISTS origin_source_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS origin_source_id UUID,
  ADD COLUMN IF NOT EXISTS origin_source_line_id UUID NULL,
  ADD COLUMN IF NOT EXISTS original_value NUMERIC(15,4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS remaining_value NUMERIC(15,4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS consumed_value NUMERIC(15,4) NOT NULL DEFAULT 0.0000;

-- Safe non-fabricating lineage backfill for any pre-053 GRN-based rows
UPDATE public.inv_ma_source_balances
SET
  source_type = COALESCE(source_type, 'GRN'),
  source_id = COALESCE(source_id, grn_id),
  source_line_id = COALESCE(source_line_id, grn_line_id),
  origin_source_type = COALESCE(origin_source_type, 'GRN'),
  origin_source_id = COALESCE(origin_source_id, grn_id),
  origin_source_line_id = COALESCE(origin_source_line_id, grn_line_id)
WHERE (source_type IS NULL OR source_id IS NULL OR origin_source_type IS NULL OR origin_source_id IS NULL)
  AND grn_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.inv_ma_source_balances
    WHERE source_type IS NULL
       OR source_id IS NULL
       OR origin_source_type IS NULL
       OR origin_source_id IS NULL
  ) THEN
    RAISE EXCEPTION 'MIGRATION_ABORTED: Existing inv_ma_source_balances rows contain NULL source or origin lineage without grn_id backfill.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.inv_ma_source_balances
    WHERE original_value < 0
       OR remaining_value < 0
       OR consumed_value < 0
       OR remaining_value + consumed_value <> original_value
  ) THEN
    RAISE EXCEPTION 'MIGRATION_ABORTED: Existing inv_ma_source_balances rows violate value non-negativity or conservation.';
  END IF;
END $$;

ALTER TABLE public.inv_ma_source_balances
  ALTER COLUMN source_type SET NOT NULL,
  ALTER COLUMN source_id SET NOT NULL,
  ALTER COLUMN origin_source_type SET NOT NULL,
  ALTER COLUMN origin_source_id SET NOT NULL;

ALTER TABLE public.inv_ma_source_balances
  DROP CONSTRAINT IF EXISTS chk_inv_ma_src_bal_val_nonneg;
ALTER TABLE public.inv_ma_source_balances
  ADD CONSTRAINT chk_inv_ma_src_bal_val_nonneg
  CHECK (original_value >= 0 AND remaining_value >= 0 AND consumed_value >= 0);

ALTER TABLE public.inv_ma_source_balances
  DROP CONSTRAINT IF EXISTS chk_inv_ma_src_bal_val_sum;
ALTER TABLE public.inv_ma_source_balances
  ADD CONSTRAINT chk_inv_ma_src_bal_val_sum
  CHECK (remaining_value + consumed_value = original_value);

ALTER TABLE public.inv_ma_source_balances
  DROP CONSTRAINT IF EXISTS uq_inv_ma_src_bal;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_ma_src_bal_identity
  ON public.inv_ma_source_balances (
    company_id,
    warehouse_id,
    item_id,
    source_type,
    source_id,
    COALESCE(source_line_id, '00000000-0000-0000-0000-000000000000'::uuid),
    origin_source_type,
    origin_source_id,
    COALESCE(origin_source_line_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS idx_inv_ma_src_bal_origin
  ON public.inv_ma_source_balances (company_id, origin_source_type, origin_source_id, origin_source_line_id);

CREATE INDEX IF NOT EXISTS idx_inv_ma_src_bal_source
  ON public.inv_ma_source_balances (company_id, source_type, source_id, source_line_id);

ALTER TABLE public.inv_ma_source_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_ma_source_balances FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inv_ma_source_balances_tenant_isolation ON public.inv_ma_source_balances;
CREATE POLICY inv_ma_source_balances_tenant_isolation ON public.inv_ma_source_balances
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON public.inv_ma_source_balances TO an_app;
REVOKE DELETE ON public.inv_ma_source_balances FROM an_app;
REVOKE ALL ON public.inv_ma_source_balances FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 2. Extend inv_ma_source_events for general sources, origin lineage & delta
-- ============================================================================
ALTER TABLE public.inv_ma_source_events
  ALTER COLUMN grn_id DROP NOT NULL,
  ALTER COLUMN grn_line_id DROP NOT NULL;

ALTER TABLE public.inv_ma_source_events
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS origin_source_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS origin_source_id UUID,
  ADD COLUMN IF NOT EXISTS origin_source_line_id UUID NULL,
  ADD COLUMN IF NOT EXISTS value_delta NUMERIC(15,4) NOT NULL DEFAULT 0.0000;

UPDATE public.inv_ma_source_events
SET
  source_type = COALESCE(
    source_type,
    CASE
      WHEN event_type = 'RECEIPT' THEN 'GRN'
      WHEN event_type IN ('TRANSFER_OUT', 'TRANSFER_IN') THEN 'WAREHOUSE_TRANSFER'
      WHEN event_type = 'PURCHASE_RETURN' THEN 'PURCHASE_RETURN'
      WHEN event_type = 'PPV' THEN 'PURCHASE_PRICE_VARIANCE'
      ELSE 'GRN'
    END
  ),
  origin_source_type = COALESCE(origin_source_type, 'GRN'),
  origin_source_id = COALESCE(origin_source_id, grn_id),
  origin_source_line_id = COALESCE(origin_source_line_id, grn_line_id)
WHERE (source_type IS NULL OR origin_source_type IS NULL OR origin_source_id IS NULL)
  AND grn_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.inv_ma_source_events
    WHERE source_type IS NULL
       OR origin_source_type IS NULL
       OR origin_source_id IS NULL
  ) THEN
    RAISE EXCEPTION 'MIGRATION_ABORTED: Existing inv_ma_source_events rows contain NULL source_type or origin lineage without grn_id backfill.';
  END IF;
END $$;

ALTER TABLE public.inv_ma_source_events
  ALTER COLUMN source_type SET NOT NULL,
  ALTER COLUMN origin_source_type SET NOT NULL,
  ALTER COLUMN origin_source_id SET NOT NULL;

ALTER TABLE public.inv_ma_source_events
  DROP CONSTRAINT IF EXISTS inv_ma_source_events_event_type_check;
ALTER TABLE public.inv_ma_source_events
  ADD CONSTRAINT inv_ma_source_events_event_type_check
  CHECK (event_type IN ('OPENING','RECEIPT','ISSUE','TRANSFER_OUT','TRANSFER_IN','PURCHASE_RETURN','PPV'));

DROP INDEX IF EXISTS public.uq_inv_ma_src_ev_idempotency;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_ma_src_ev_idempotency
  ON public.inv_ma_source_events (
    company_id,
    event_type,
    warehouse_id,
    item_id,
    origin_source_type,
    origin_source_id,
    COALESCE(origin_source_line_id, '00000000-0000-0000-0000-000000000000'::uuid),
    source_type,
    source_id,
    COALESCE(source_line_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS idx_inv_ma_src_ev_origin
  ON public.inv_ma_source_events (company_id, origin_source_type, origin_source_id, origin_source_line_id);

CREATE INDEX IF NOT EXISTS idx_inv_ma_src_ev_mov
  ON public.inv_ma_source_events (company_id, reference_movement_id)
  WHERE reference_movement_id IS NOT NULL;

ALTER TABLE public.inv_ma_source_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_ma_source_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inv_ma_source_events_tenant_isolation ON public.inv_ma_source_events;
CREATE POLICY inv_ma_source_events_tenant_isolation ON public.inv_ma_source_events
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON public.inv_ma_source_events TO an_app;
REVOKE UPDATE, DELETE ON public.inv_ma_source_events FROM an_app;
REVOKE ALL ON public.inv_ma_source_events FROM PUBLIC, anon, authenticated;
