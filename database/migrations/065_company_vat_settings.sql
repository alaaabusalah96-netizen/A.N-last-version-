-- Migration 065: configurable company VAT settings (additive, safe defaults).
-- VAT is OFF by default: no behaviour changes for any existing company until it is enabled.
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS vat_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS default_vat_rate NUMERIC(5, 2) NOT NULL DEFAULT 0;
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS prices_include_vat BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS vat_input_recoverable BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS vat_rounding_mode TEXT NOT NULL DEFAULT 'line';
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS vat_input_account_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_company_settings_default_vat_rate') THEN
    ALTER TABLE public.company_settings
      ADD CONSTRAINT chk_company_settings_default_vat_rate CHECK (default_vat_rate >= 0 AND default_vat_rate <= 100);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_company_settings_vat_rounding_mode') THEN
    ALTER TABLE public.company_settings
      ADD CONSTRAINT chk_company_settings_vat_rounding_mode CHECK (vat_rounding_mode IN ('line', 'document'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_company_settings_vat_input_account') THEN
    ALTER TABLE public.company_settings
      ADD CONSTRAINT fk_company_settings_vat_input_account
      FOREIGN KEY (vat_input_account_id, company_id)
      REFERENCES public.accounts (id, company_id)
      ON DELETE SET NULL (vat_input_account_id);
  END IF;
END $$;
