-- Migration 052: Inventory Valuation Composite FK Repair
-- Forward-only migration replacing malformed / duplicate FKs on
-- public.inv_sales_cogs_reversals (reversal_journal_entry_id) with a single
-- column-scoped composite FK: ON DELETE SET NULL (reversal_journal_entry_id).
-- Zero EXCEPTION WHEN OTHERS.

DO $$
DECLARE
  fk_rec RECORD;
BEGIN
  FOR fk_rec IN
    SELECT DISTINCT c.conname
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_class ref ON ref.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE ns.nspname = 'public'
      AND cl.relname = 'inv_sales_cogs_reversals'
      AND ref.relname = 'journal_entries'
      AND c.contype = 'f'
      AND a.attname = 'reversal_journal_entry_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.inv_sales_cogs_reversals DROP CONSTRAINT IF EXISTS %I',
      fk_rec.conname
    );
  END LOOP;
END $$;

ALTER TABLE public.inv_sales_cogs_reversals
  ADD CONSTRAINT fk_inv_cogs_rev_je
  FOREIGN KEY (reversal_journal_entry_id, company_id)
  REFERENCES public.journal_entries (id, company_id)
  ON DELETE SET NULL (reversal_journal_entry_id);
