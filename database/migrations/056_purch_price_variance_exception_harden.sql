-- Migration 056: Purchasing Price Variance Exception Hardening (Package 7C Followup 1)
-- Corrective migration for purch_price_variance_exceptions:
--   1) RLS policy recreation with explicit TO an_app
--   2) Additional audit columns: superseded_by, superseded_at, decided_at
--   3) Composite tenant-safe foreign keys: (company_id, invoice_id) and (company_id, supplier_id)
--   4) BEFORE UPDATE OR DELETE trigger enforcing terminal decision immutability and transition rules
-- Zero EXCEPTION WHEN OTHERS.

-- ============================================================================
-- 1. RLS Policy Hardening with explicit TO an_app
-- ============================================================================
ALTER TABLE public.purch_price_variance_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purch_price_variance_exceptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS purch_price_variance_exceptions_tenant_isolation ON public.purch_price_variance_exceptions;
CREATE POLICY purch_price_variance_exceptions_tenant_isolation ON public.purch_price_variance_exceptions
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.purch_price_variance_exceptions TO an_app;
REVOKE ALL ON public.purch_price_variance_exceptions FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 2. Audit Columns
-- ============================================================================
ALTER TABLE public.purch_price_variance_exceptions
  ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES public.platform_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

-- ============================================================================
-- 3. Composite Foreign Keys
-- ============================================================================
DO $$
DECLARE
  orphan_count INT;
BEGIN
  -- Pre-check invoice composite reference
  SELECT COUNT(*) INTO orphan_count
  FROM public.purch_price_variance_exceptions e
  LEFT JOIN public.purch_supplier_invoices i ON e.invoice_id = i.id AND e.company_id = i.company_id
  WHERE i.id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 056 ABORTED: Found % purch_price_variance_exceptions with mismatched invoice reference!', orphan_count;
  END IF;

  -- Pre-check supplier composite reference
  SELECT COUNT(*) INTO orphan_count
  FROM public.purch_price_variance_exceptions e
  LEFT JOIN public.purch_suppliers s ON e.supplier_id = s.id AND e.company_id = s.company_id
  WHERE s.id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 056 ABORTED: Found % purch_price_variance_exceptions with mismatched supplier reference!', orphan_count;
  END IF;
END $$;

-- Drop simple FKs if present and replace with composite tenant FKs
ALTER TABLE public.purch_price_variance_exceptions
  DROP CONSTRAINT IF EXISTS purch_price_variance_exceptions_invoice_id_fkey,
  DROP CONSTRAINT IF EXISTS purch_price_variance_exceptions_supplier_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_purch_price_variance_exceptions_invoice_composite'
  ) THEN
    ALTER TABLE public.purch_price_variance_exceptions
      ADD CONSTRAINT fk_purch_price_variance_exceptions_invoice_composite
      FOREIGN KEY (company_id, invoice_id)
      REFERENCES public.purch_supplier_invoices(company_id, id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_purch_price_variance_exceptions_supplier_composite'
  ) THEN
    ALTER TABLE public.purch_price_variance_exceptions
      ADD CONSTRAINT fk_purch_price_variance_exceptions_supplier_composite
      FOREIGN KEY (company_id, supplier_id)
      REFERENCES public.purch_suppliers(company_id, id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- ============================================================================
-- 4. Decision Immutability & Status Transition Trigger
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_guard_purch_price_variance_exceptions()
RETURNS TRIGGER AS $$
BEGIN
  -- 1. Block DELETE always
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deleting price variance exception records is strictly forbidden'
      USING ERRCODE = '23505';
  END IF;

  -- 2. Guard UPDATE operations
  IF TG_OP = 'UPDATE' THEN
    -- Immutable structural columns regardless of status
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'id is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'company_id is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
      RAISE EXCEPTION 'invoice_id is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
      RAISE EXCEPTION 'supplier_id is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
      RAISE EXCEPTION 'requested_by is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.reason IS DISTINCT FROM OLD.reason THEN
      RAISE EXCEPTION 'reason is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.fingerprint IS DISTINCT FROM OLD.fingerprint THEN
      RAISE EXCEPTION 'fingerprint is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
      RAISE EXCEPTION 'snapshot is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.max_variance_pct IS DISTINCT FROM OLD.max_variance_pct THEN
      RAISE EXCEPTION 'max_variance_pct is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'created_at is immutable' USING ERRCODE = '23514';
    END IF;

    -- Terminal states: rejected and superseded cannot be changed at all
    IF OLD.status = 'rejected' THEN
      RAISE EXCEPTION 'Rejected price variance exception cannot be modified' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'superseded' THEN
      RAISE EXCEPTION 'Superseded price variance exception cannot be modified' USING ERRCODE = '23514';
    END IF;

    -- If currently approved: only transition to superseded is allowed
    IF OLD.status = 'approved' THEN
      IF NEW.status IS DISTINCT FROM 'superseded' THEN
        RAISE EXCEPTION 'Approved price variance exception can only transition to superseded' USING ERRCODE = '23514';
      END IF;
      -- Immutable fields once approved
      IF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
        RAISE EXCEPTION 'approved_by is immutable once approved' USING ERRCODE = '23514';
      END IF;
      IF NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
        RAISE EXCEPTION 'decided_at is immutable once approved' USING ERRCODE = '23514';
      END IF;
      -- Must record superseded reason and timestamp
      IF NEW.decision_reason IS NULL OR TRIM(NEW.decision_reason) = '' THEN
        RAISE EXCEPTION 'decision_reason is required when superseding an approved exception' USING ERRCODE = '23514';
      END IF;
      IF NEW.superseded_at IS NULL THEN
        NEW.superseded_at := NOW();
      END IF;
    END IF;

    -- If currently pending: can transition to approved, rejected, or superseded
    IF OLD.status = 'pending' THEN
      IF NEW.status = 'approved' THEN
        IF NEW.approved_by IS NULL THEN
          RAISE EXCEPTION 'approved_by is required when approving an exception' USING ERRCODE = '23514';
        END IF;
        IF NEW.decided_at IS NULL THEN
          NEW.decided_at := NOW();
        END IF;
      ELSIF NEW.status = 'rejected' THEN
        IF NEW.rejected_by IS NULL THEN
          RAISE EXCEPTION 'rejected_by is required when rejecting an exception' USING ERRCODE = '23514';
        END IF;
        IF NEW.decided_at IS NULL THEN
          NEW.decided_at := NOW();
        END IF;
      ELSIF NEW.status = 'superseded' THEN
        IF NEW.decision_reason IS NULL OR TRIM(NEW.decision_reason) = '' THEN
          RAISE EXCEPTION 'decision_reason is required when superseding an exception' USING ERRCODE = '23514';
        END IF;
        IF NEW.superseded_at IS NULL THEN
          NEW.superseded_at := NOW();
        END IF;
      ELSIF NEW.status = 'pending' THEN
        -- Allow pending to stay pending (e.g. metadata touch)
      ELSE
        RAISE EXCEPTION 'Invalid status transition from pending to %', NEW.status USING ERRCODE = '23514';
      END IF;
    END IF;

    NEW.updated_at := NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_purch_price_variance_exceptions ON public.purch_price_variance_exceptions;
CREATE TRIGGER trg_guard_purch_price_variance_exceptions
  BEFORE UPDATE OR DELETE ON public.purch_price_variance_exceptions
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_purch_price_variance_exceptions();
