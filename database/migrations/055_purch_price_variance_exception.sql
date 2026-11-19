-- Migration 055: Purchasing Price Variance Exceptions (Package 7C2)
-- Forward-only migration introducing:
--   1) purch_price_variance_exceptions table with RLS + FORCE RLS and least-privilege grants for an_app.
--   2) Partial unique index for active approved exception per invoice.
-- Zero EXCEPTION WHEN OTHERS.

-- ============================================================================
-- 1. Create purch_price_variance_exceptions table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.purch_price_variance_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES public.purch_supplier_invoices(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES public.purch_suppliers(id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  requested_by UUID REFERENCES public.platform_users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES public.platform_users(id) ON DELETE SET NULL,
  rejected_by UUID REFERENCES public.platform_users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  decision_reason TEXT,
  fingerprint VARCHAR(128) NOT NULL,
  snapshot JSONB NOT NULL,
  max_variance_pct NUMERIC(10, 4) NOT NULL DEFAULT 5.0000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT purch_price_variance_exceptions_status_check 
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_purch_price_exc_active_approved 
  ON public.purch_price_variance_exceptions (company_id, invoice_id) 
  WHERE (status = 'approved');

CREATE INDEX IF NOT EXISTS idx_purch_price_exc_invoice 
  ON public.purch_price_variance_exceptions (company_id, invoice_id);

CREATE INDEX IF NOT EXISTS idx_purch_price_exc_status 
  ON public.purch_price_variance_exceptions (company_id, status);

-- ============================================================================
-- 2. RLS & Security Policies
-- ============================================================================
ALTER TABLE public.purch_price_variance_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purch_price_variance_exceptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS purch_price_variance_exceptions_tenant_isolation ON public.purch_price_variance_exceptions;
CREATE POLICY purch_price_variance_exceptions_tenant_isolation ON public.purch_price_variance_exceptions
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.purch_price_variance_exceptions TO an_app;
REVOKE ALL ON public.purch_price_variance_exceptions FROM PUBLIC, anon, authenticated;
