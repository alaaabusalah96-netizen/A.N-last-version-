-- Migration 043: Cash Custody Account Composite FK Hardening (AN-FOUNDATION-HARDEN-1)
-- Hardens company_settings.custody_receivable_account_id foreign key integrity via a forward migration.
-- Leaves 038_cash_custody_core.sql untouched (preserved checksum).
-- Fail-loud forward migration: any structural inconsistency aborts immediately without exception swallowing.

-- 1. Clean any cross-company or dangling custody_receivable_account_id references in company_settings
UPDATE public.company_settings cs
SET custody_receivable_account_id = NULL
WHERE cs.custody_receivable_account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.accounts a
    WHERE a.id = cs.custody_receivable_account_id
      AND a.company_id = cs.company_id
  );

-- 2. Drop any flawed single-column FK on company_settings(custody_receivable_account_id) -> accounts(id)
--    (e.g., auto-named company_settings_custody_receivable_account_id_fkey created in migration 038)
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  FOR v_conname IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE ns.nspname = 'public'
      AND cl.relname = 'company_settings'
      AND c.contype = 'f'
      AND c.confrelid = 'public.accounts'::regclass
      AND array_length(c.conkey, 1) = 1
      AND EXISTS (
        SELECT 1
        FROM pg_attribute a
        WHERE a.attrelid = cl.oid
          AND a.attnum = c.conkey[1]
          AND a.attname = 'custody_receivable_account_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.company_settings DROP CONSTRAINT IF EXISTS %I', v_conname);
  END LOOP;
END $$;

-- 3. Ensure hardened composite FK (custody_receivable_account_id, company_id) -> accounts(id, company_id)
--    with column-specific ON DELETE SET NULL (custody_receivable_account_id)
ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_custody_account_company_fk;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_custody_account_company_fk
  FOREIGN KEY (custody_receivable_account_id, company_id)
  REFERENCES public.accounts (id, company_id)
  ON DELETE SET NULL (custody_receivable_account_id);
