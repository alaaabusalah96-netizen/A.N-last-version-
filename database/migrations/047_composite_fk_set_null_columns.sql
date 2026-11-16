-- Migration 047: Column-Scoped ON DELETE SET NULL on Composite Tenant Foreign Keys (AN-INT-DB-FK-1)
-- Ensures deleting a referenced parent row sets ONLY the nullable FK column to NULL
-- instead of attempting to nullify NOT NULL company_id.
-- Fail-loud forward migration: zero EXCEPTION WHEN OTHERS.

-- 1. company_settings.accounts_payable_account_id (from 041)
ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS fk_company_settings_ap_account;

ALTER TABLE public.company_settings
  ADD CONSTRAINT fk_company_settings_ap_account
  FOREIGN KEY (accounts_payable_account_id, company_id)
  REFERENCES public.accounts (id, company_id)
  ON DELETE SET NULL (accounts_payable_account_id);

-- 2. purch_returns.invoice_id (from 044)
ALTER TABLE public.purch_returns
  DROP CONSTRAINT IF EXISTS fk_purch_returns_invoice;

ALTER TABLE public.purch_returns
  ADD CONSTRAINT fk_purch_returns_invoice
  FOREIGN KEY (invoice_id, company_id)
  REFERENCES public.purch_supplier_invoices (id, company_id)
  ON DELETE SET NULL (invoice_id);

-- 3. company_settings.accounts_receivable_account_id (from 045)
ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS fk_company_settings_ar_account;

ALTER TABLE public.company_settings
  ADD CONSTRAINT fk_company_settings_ar_account
  FOREIGN KEY (accounts_receivable_account_id, company_id)
  REFERENCES public.accounts (id, company_id)
  ON DELETE SET NULL (accounts_receivable_account_id);

-- 4. company_settings.sales_revenue_account_id (from 045)
ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS fk_company_settings_sales_rev_account;

ALTER TABLE public.company_settings
  ADD CONSTRAINT fk_company_settings_sales_rev_account
  FOREIGN KEY (sales_revenue_account_id, company_id)
  REFERENCES public.accounts (id, company_id)
  ON DELETE SET NULL (sales_revenue_account_id);

-- 5. sales_invoices.delivery_id (from 045)
ALTER TABLE public.sales_invoices
  DROP CONSTRAINT IF EXISTS fk_sales_invoices_delivery;

ALTER TABLE public.sales_invoices
  ADD CONSTRAINT fk_sales_invoices_delivery
  FOREIGN KEY (delivery_id, company_id)
  REFERENCES public.sales_delivery_notes (id, company_id)
  ON DELETE SET NULL (delivery_id);

-- 6. sales_invoice_lines.delivery_line_id (from 045)
ALTER TABLE public.sales_invoice_lines
  DROP CONSTRAINT IF EXISTS fk_sales_invoice_lines_delivery_line;

ALTER TABLE public.sales_invoice_lines
  ADD CONSTRAINT fk_sales_invoice_lines_delivery_line
  FOREIGN KEY (delivery_line_id, company_id)
  REFERENCES public.sales_delivery_lines (id, company_id)
  ON DELETE SET NULL (delivery_line_id);

-- 7. fin_bank_statement_lines.matched_journal_line_id (from 046)
ALTER TABLE public.fin_bank_statement_lines
  DROP CONSTRAINT IF EXISTS fk_fin_bank_stmt_lines_jl;

ALTER TABLE public.fin_bank_statement_lines
  ADD CONSTRAINT fk_fin_bank_stmt_lines_jl
  FOREIGN KEY (matched_journal_line_id, company_id)
  REFERENCES public.journal_lines (id, company_id)
  ON DELETE SET NULL (matched_journal_line_id);

-- 8. fin_bank_statement_lines.reconciliation_id (from 046)
ALTER TABLE public.fin_bank_statement_lines
  DROP CONSTRAINT IF EXISTS fk_fin_bank_stmt_lines_recon;

ALTER TABLE public.fin_bank_statement_lines
  ADD CONSTRAINT fk_fin_bank_stmt_lines_recon
  FOREIGN KEY (reconciliation_id, company_id)
  REFERENCES public.fin_bank_reconciliations (id, company_id)
  ON DELETE SET NULL (reconciliation_id);
