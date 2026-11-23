-- Migration 057: Purchasing Price Variance Exception Guards (AN-ERP-R04-DB-GUARDS)
-- Forward-only corrective migration after 056 hardening:
--   1) Separate supersede_reason from decision_reason (preserve approval/rejection reasons on supersede).
--   2) Strict legacy precheck before constraints: abort with diagnostic counts if invalid rows exist; zero silent repairs, zero fabricated actors/reasons.
--   3) Enforce NOT NULL requested_by and non-blank reason + strict state invariants CHECK constraint.
--   4) Replace ON DELETE CASCADE / ON DELETE SET NULL FKs with ON DELETE RESTRICT across all parent relations.
--   5) Upgrade trigger to BEFORE INSERT OR UPDATE OR DELETE enforcing full DB state machine, DB-level SoD, supplier/invoice match, and immutable decision metadata.
-- Zero EXCEPTION WHEN OTHERS.

-- ============================================================================
-- 1. Add separate supersede_reason column
-- ============================================================================
ALTER TABLE public.purch_price_variance_exceptions
  ADD COLUMN IF NOT EXISTS supersede_reason TEXT NULL;

-- ============================================================================
-- 2. Strict Legacy Data Precheck (Fail Loudly with Diagnostics, No Silent Fix)
-- ============================================================================
DO $$
DECLARE
  v_bad_company INT;
  v_bad_invoice INT;
  v_bad_supplier INT;
  v_mismatched_supplier INT;
  v_missing_requested_by INT;
  v_missing_user_fk INT;
  v_blank_reason INT;
  v_dup_approved INT;
  v_bad_pending INT;
  v_bad_approved INT;
  v_bad_rejected INT;
  v_bad_superseded INT;
  v_bad_status INT;
  v_total_errors INT;
BEGIN
  SELECT COUNT(*) INTO v_bad_company
  FROM public.purch_price_variance_exceptions e
  LEFT JOIN public.companies c ON c.id = e.company_id
  WHERE e.company_id IS NULL OR c.id IS NULL;

  SELECT COUNT(*) INTO v_bad_invoice
  FROM public.purch_price_variance_exceptions e
  LEFT JOIN public.purch_supplier_invoices i
    ON i.company_id = e.company_id AND i.id = e.invoice_id
  WHERE i.id IS NULL;

  SELECT COUNT(*) INTO v_bad_supplier
  FROM public.purch_price_variance_exceptions e
  LEFT JOIN public.purch_suppliers s
    ON s.company_id = e.company_id AND s.id = e.supplier_id
  WHERE s.id IS NULL;

  SELECT COUNT(*) INTO v_mismatched_supplier
  FROM public.purch_price_variance_exceptions e
  JOIN public.purch_supplier_invoices i
    ON i.company_id = e.company_id AND i.id = e.invoice_id
  WHERE e.supplier_id IS DISTINCT FROM i.supplier_id;

  SELECT COUNT(*) INTO v_missing_requested_by
  FROM public.purch_price_variance_exceptions e
  WHERE e.requested_by IS NULL;

  SELECT COUNT(*) INTO v_missing_user_fk
  FROM public.purch_price_variance_exceptions e
  WHERE (e.requested_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.platform_users u WHERE u.id = e.requested_by))
     OR (e.approved_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.platform_users u WHERE u.id = e.approved_by))
     OR (e.rejected_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.platform_users u WHERE u.id = e.rejected_by))
     OR (e.superseded_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.platform_users u WHERE u.id = e.superseded_by));

  SELECT COUNT(*) INTO v_blank_reason
  FROM public.purch_price_variance_exceptions e
  WHERE e.reason IS NULL OR BTRIM(e.reason) = '';

  SELECT COUNT(*) INTO v_dup_approved
  FROM (
    SELECT company_id, invoice_id
    FROM public.purch_price_variance_exceptions
    WHERE status = 'approved'
    GROUP BY company_id, invoice_id
    HAVING COUNT(*) > 1
  ) dup;

  SELECT COUNT(*) INTO v_bad_pending
  FROM public.purch_price_variance_exceptions e
  WHERE e.status = 'pending'
    AND (
      e.approved_by IS NOT NULL
      OR e.rejected_by IS NOT NULL
      OR e.superseded_by IS NOT NULL
      OR e.decided_at IS NOT NULL
      OR e.superseded_at IS NOT NULL
      OR e.decision_reason IS NOT NULL
      OR e.supersede_reason IS NOT NULL
    );

  SELECT COUNT(*) INTO v_bad_approved
  FROM public.purch_price_variance_exceptions e
  WHERE e.status = 'approved'
    AND (
      e.approved_by IS NULL
      OR e.decided_at IS NULL
      OR (e.requested_by IS NOT NULL AND e.approved_by = e.requested_by)
      OR e.rejected_by IS NOT NULL
      OR e.superseded_by IS NOT NULL
      OR e.superseded_at IS NOT NULL
      OR e.supersede_reason IS NOT NULL
    );

  SELECT COUNT(*) INTO v_bad_rejected
  FROM public.purch_price_variance_exceptions e
  WHERE e.status = 'rejected'
    AND (
      e.rejected_by IS NULL
      OR e.decided_at IS NULL
      OR (e.requested_by IS NOT NULL AND e.rejected_by = e.requested_by)
      OR e.approved_by IS NOT NULL
      OR e.superseded_by IS NOT NULL
      OR e.superseded_at IS NOT NULL
      OR e.supersede_reason IS NOT NULL
    );

  -- Valid legacy pre-057 superseded rows may have supersede_reason IS NULL with non-empty decision_reason.
  -- Invalid superseded rows are aborted loudly without fabricating actors or reasons.
  SELECT COUNT(*) INTO v_bad_superseded
  FROM public.purch_price_variance_exceptions e
  WHERE e.status = 'superseded'
    AND (
      e.superseded_by IS NULL
      OR e.superseded_at IS NULL
      OR e.rejected_by IS NOT NULL
      OR ((e.approved_by IS NULL) <> (e.decided_at IS NULL))
      OR (e.approved_by IS NOT NULL AND e.requested_by IS NOT NULL AND e.approved_by = e.requested_by)
      OR (
        NULLIF(BTRIM(e.supersede_reason), '') IS NULL
        AND NOT (e.supersede_reason IS NULL AND NULLIF(BTRIM(e.decision_reason), '') IS NOT NULL)
      )
    );

  SELECT COUNT(*) INTO v_bad_status
  FROM public.purch_price_variance_exceptions e
  WHERE e.status IS NULL OR e.status NOT IN ('pending', 'approved', 'rejected', 'superseded');

  v_total_errors := v_bad_company
    + v_bad_invoice
    + v_bad_supplier
    + v_mismatched_supplier
    + v_missing_requested_by
    + v_missing_user_fk
    + v_blank_reason
    + v_dup_approved
    + v_bad_pending
    + v_bad_approved
    + v_bad_rejected
    + v_bad_superseded
    + v_bad_status;

  IF v_total_errors > 0 THEN
    RAISE EXCEPTION
      'MIGRATION 057 ABORTED: Invalid legacy rows detected in public.purch_price_variance_exceptions [bad_company=%, bad_invoice=%, bad_supplier=%, mismatched_supplier=%, missing_requested_by=%, missing_user_fk=%, blank_reason=%, dup_approved=%, bad_pending=%, bad_approved=%, bad_rejected=%, bad_superseded=%, bad_status=%]. Manual data audit required; no silent repairs applied.',
      v_bad_company,
      v_bad_invoice,
      v_bad_supplier,
      v_mismatched_supplier,
      v_missing_requested_by,
      v_missing_user_fk,
      v_blank_reason,
      v_dup_approved,
      v_bad_pending,
      v_bad_approved,
      v_bad_rejected,
      v_bad_superseded,
      v_bad_status
      USING ERRCODE = '23514';
  END IF;
END $$;

-- ============================================================================
-- 3. Enforce NOT NULL requested_by and ON DELETE RESTRICT Foreign Keys
-- ============================================================================
ALTER TABLE public.purch_price_variance_exceptions
  ALTER COLUMN requested_by SET NOT NULL;

DO $$
DECLARE
  fk_rec RECORD;
BEGIN
  FOR fk_rec IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.purch_price_variance_exceptions'::regclass
      AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE public.purch_price_variance_exceptions DROP CONSTRAINT IF EXISTS %I', fk_rec.conname);
  END LOOP;
END $$;

ALTER TABLE public.purch_price_variance_exceptions
  ADD CONSTRAINT fk_purch_price_variance_exceptions_company
    FOREIGN KEY (company_id)
    REFERENCES public.companies(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT fk_purch_price_variance_exceptions_invoice_composite
    FOREIGN KEY (company_id, invoice_id)
    REFERENCES public.purch_supplier_invoices(company_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT fk_purch_price_variance_exceptions_supplier_composite
    FOREIGN KEY (company_id, supplier_id)
    REFERENCES public.purch_suppliers(company_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT fk_purch_price_variance_exceptions_requested_by
    FOREIGN KEY (requested_by)
    REFERENCES public.platform_users(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT fk_purch_price_variance_exceptions_approved_by
    FOREIGN KEY (approved_by)
    REFERENCES public.platform_users(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT fk_purch_price_variance_exceptions_rejected_by
    FOREIGN KEY (rejected_by)
    REFERENCES public.platform_users(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT fk_purch_price_variance_exceptions_superseded_by
    FOREIGN KEY (superseded_by)
    REFERENCES public.platform_users(id)
    ON DELETE RESTRICT;

-- ============================================================================
-- 4. Table-Level State Invariant CHECK Constraints
-- ============================================================================
ALTER TABLE public.purch_price_variance_exceptions
  DROP CONSTRAINT IF EXISTS chk_purch_price_exc_reason_nonblank,
  DROP CONSTRAINT IF EXISTS chk_purch_price_exc_state_invariants;

ALTER TABLE public.purch_price_variance_exceptions
  ADD CONSTRAINT chk_purch_price_exc_reason_nonblank
    CHECK (NULLIF(BTRIM(reason), '') IS NOT NULL),
  ADD CONSTRAINT chk_purch_price_exc_state_invariants
    CHECK (
      (
        status = 'pending'
        AND approved_by IS NULL
        AND rejected_by IS NULL
        AND superseded_by IS NULL
        AND decided_at IS NULL
        AND superseded_at IS NULL
        AND decision_reason IS NULL
        AND supersede_reason IS NULL
      )
      OR (
        status = 'approved'
        AND approved_by IS NOT NULL
        AND decided_at IS NOT NULL
        AND approved_by <> requested_by
        AND rejected_by IS NULL
        AND superseded_by IS NULL
        AND superseded_at IS NULL
        AND supersede_reason IS NULL
      )
      OR (
        status = 'rejected'
        AND rejected_by IS NOT NULL
        AND decided_at IS NOT NULL
        AND rejected_by <> requested_by
        AND approved_by IS NULL
        AND superseded_by IS NULL
        AND superseded_at IS NULL
        AND supersede_reason IS NULL
      )
      OR (
        status = 'superseded'
        AND superseded_by IS NOT NULL
        AND superseded_at IS NOT NULL
        AND rejected_by IS NULL
        AND (
          (approved_by IS NULL AND decided_at IS NULL)
          OR (approved_by IS NOT NULL AND decided_at IS NOT NULL AND approved_by <> requested_by)
        )
        AND (
          NULLIF(BTRIM(supersede_reason), '') IS NOT NULL
          OR (supersede_reason IS NULL AND NULLIF(BTRIM(decision_reason), '') IS NOT NULL)
        )
      )
    );

-- ============================================================================
-- 5. Strict DB State Machine, SoD, Supplier-Match, & Immutability Trigger
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_guard_purch_price_variance_exceptions()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_invoice_supplier_id UUID;
BEGIN
  -- 1. Block DELETE always
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deleting price variance exception records is strictly forbidden'
      USING ERRCODE = '23514';
  END IF;

  -- 2. Guard INSERT operations: must begin strictly as clean pending request
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'New price variance exception must start in pending status'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.requested_by IS NULL THEN
      RAISE EXCEPTION 'requested_by is required on price variance exception insert'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.reason IS NULL OR BTRIM(NEW.reason) = '' THEN
      RAISE EXCEPTION 'reason cannot be blank on price variance exception insert'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.approved_by IS NOT NULL
       OR NEW.rejected_by IS NOT NULL
       OR NEW.superseded_by IS NOT NULL
       OR NEW.decided_at IS NOT NULL
       OR NEW.superseded_at IS NOT NULL
       OR NEW.decision_reason IS NOT NULL
       OR NEW.supersede_reason IS NOT NULL THEN
      RAISE EXCEPTION 'Decision and supersede metadata must be NULL when creating a pending price variance exception'
        USING ERRCODE = '23514';
    END IF;

    -- Verify supplier_id matches the invoice's supplier_id when invoice exists in same company.
    -- If the invoice does not exist in NEW.company_id, defer to composite FK (SQLSTATE 23503).
    SELECT i.supplier_id
    INTO v_invoice_supplier_id
    FROM public.purch_supplier_invoices i
    WHERE i.company_id = NEW.company_id
      AND i.id = NEW.invoice_id;

    IF v_invoice_supplier_id IS NOT NULL AND v_invoice_supplier_id IS DISTINCT FROM NEW.supplier_id THEN
      RAISE EXCEPTION 'supplier_id must match the supplier of the referenced invoice'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  -- 3. Guard UPDATE operations
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

    -- Approved state: can ONLY transition to superseded, preserving approval metadata intact
    IF OLD.status = 'approved' THEN
      IF NEW.status IS DISTINCT FROM 'superseded' THEN
        RAISE EXCEPTION 'Approved price variance exception can only transition to superseded' USING ERRCODE = '23514';
      END IF;
      IF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
        RAISE EXCEPTION 'approved_by is immutable once approved' USING ERRCODE = '23514';
      END IF;
      IF NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
        RAISE EXCEPTION 'decided_at is immutable once approved' USING ERRCODE = '23514';
      END IF;
      IF NEW.decision_reason IS DISTINCT FROM OLD.decision_reason THEN
        RAISE EXCEPTION 'decision_reason is immutable once approved' USING ERRCODE = '23514';
      END IF;
      IF NEW.rejected_by IS NOT NULL THEN
        RAISE EXCEPTION 'rejected_by cannot be set on approved exception' USING ERRCODE = '23514';
      END IF;
      IF NEW.superseded_by IS NULL THEN
        RAISE EXCEPTION 'superseded_by is required when superseding an approved exception' USING ERRCODE = '23514';
      END IF;
      IF NEW.supersede_reason IS NULL OR BTRIM(NEW.supersede_reason) = '' THEN
        RAISE EXCEPTION 'supersede_reason is required when superseding an approved exception' USING ERRCODE = '23514';
      END IF;
      IF NEW.superseded_at IS NULL THEN
        NEW.superseded_at := NOW();
      END IF;
      NEW.updated_at := NOW();
      RETURN NEW;
    END IF;

    -- Pending state: can transition ONLY to approved, rejected, or superseded (no pending -> pending)
    IF OLD.status = 'pending' THEN
      IF NEW.status = 'pending' THEN
        RAISE EXCEPTION 'Updating a pending price variance exception without a valid state transition is forbidden'
          USING ERRCODE = '23514';
      ELSIF NEW.status = 'approved' THEN
        IF NEW.approved_by IS NULL THEN
          RAISE EXCEPTION 'approved_by is required when approving an exception' USING ERRCODE = '23514';
        END IF;
        IF NEW.approved_by = OLD.requested_by THEN
          RAISE EXCEPTION 'SoD violation: requester cannot approve own price variance exception' USING ERRCODE = '23514';
        END IF;
        IF NEW.rejected_by IS NOT NULL
           OR NEW.superseded_by IS NOT NULL
           OR NEW.superseded_at IS NOT NULL
           OR NEW.supersede_reason IS NOT NULL THEN
          RAISE EXCEPTION 'Invalid rejection or supersede metadata on approved transition' USING ERRCODE = '23514';
        END IF;
        IF NEW.decided_at IS NULL THEN
          NEW.decided_at := NOW();
        END IF;
      ELSIF NEW.status = 'rejected' THEN
        IF NEW.rejected_by IS NULL THEN
          RAISE EXCEPTION 'rejected_by is required when rejecting an exception' USING ERRCODE = '23514';
        END IF;
        IF NEW.rejected_by = OLD.requested_by THEN
          RAISE EXCEPTION 'SoD violation: requester cannot reject own price variance exception' USING ERRCODE = '23514';
        END IF;
        IF NEW.approved_by IS NOT NULL
           OR NEW.superseded_by IS NOT NULL
           OR NEW.superseded_at IS NOT NULL
           OR NEW.supersede_reason IS NOT NULL THEN
          RAISE EXCEPTION 'Invalid approval or supersede metadata on rejected transition' USING ERRCODE = '23514';
        END IF;
        IF NEW.decided_at IS NULL THEN
          NEW.decided_at := NOW();
        END IF;
      ELSIF NEW.status = 'superseded' THEN
        IF NEW.superseded_by IS NULL THEN
          RAISE EXCEPTION 'superseded_by is required when superseding a pending exception' USING ERRCODE = '23514';
        END IF;
        IF NEW.supersede_reason IS NULL OR BTRIM(NEW.supersede_reason) = '' THEN
          RAISE EXCEPTION 'supersede_reason is required when superseding a pending exception' USING ERRCODE = '23514';
        END IF;
        IF NEW.approved_by IS NOT NULL
           OR NEW.rejected_by IS NOT NULL
           OR NEW.decided_at IS NOT NULL
           OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason THEN
          RAISE EXCEPTION 'Decision metadata must remain untouched when superseding a pending exception' USING ERRCODE = '23514';
        END IF;
        IF NEW.superseded_at IS NULL THEN
          NEW.superseded_at := NOW();
        END IF;
      ELSE
        RAISE EXCEPTION 'Invalid status transition from pending to %', NEW.status USING ERRCODE = '23514';
      END IF;

      NEW.updated_at := NOW();
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Unsupported price variance exception source status: %', OLD.status USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_purch_price_variance_exceptions ON public.purch_price_variance_exceptions;
CREATE TRIGGER trg_guard_purch_price_variance_exceptions
  BEFORE INSERT OR UPDATE OR DELETE ON public.purch_price_variance_exceptions
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_purch_price_variance_exceptions();

-- ============================================================================
-- 6. Re-affirm Tenant Isolation RLS & Least-Privilege Grants
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
