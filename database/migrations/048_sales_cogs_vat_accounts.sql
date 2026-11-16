-- Migration 048: Sales COGS & VAT Payable Company Settings Accounts (AN-INT-SALES-1)
-- Adds fail-closed GL mapping columns for Cost of Goods Sold (COGS) and Sales Output VAT Payable
-- to company_settings with tenant-safe composite foreign keys and column-scoped ON DELETE SET NULL.
-- Zero EXCEPTION WHEN OTHERS.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'company_settings' AND column_name = 'cogs_account_id'
  ) THEN
    ALTER TABLE public.company_settings
      ADD COLUMN cogs_account_id UUID NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_company_settings_cogs_account'
  ) THEN
    ALTER TABLE public.company_settings
      ADD CONSTRAINT fk_company_settings_cogs_account
      FOREIGN KEY (cogs_account_id, company_id)
      REFERENCES public.accounts (id, company_id)
      ON DELETE SET NULL (cogs_account_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'company_settings' AND column_name = 'vat_payable_account_id'
  ) THEN
    ALTER TABLE public.company_settings
      ADD COLUMN vat_payable_account_id UUID NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_company_settings_vat_payable_account'
  ) THEN
    ALTER TABLE public.company_settings
      ADD CONSTRAINT fk_company_settings_vat_payable_account
      FOREIGN KEY (vat_payable_account_id, company_id)
      REFERENCES public.accounts (id, company_id)
      ON DELETE SET NULL (vat_payable_account_id);
  END IF;
END $$;
