-- Migration 025: Composite FKs for GRN and Company Settings

-- 1. Precheck: Fail if any orphans exist
DO $$
BEGIN
    -- Orphans in purch_grn
    IF EXISTS (
        SELECT 1 FROM purch_grn pg
        WHERE pg.journal_entry_id IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM journal_entries je
            WHERE je.id = pg.journal_entry_id
            AND je.company_id = pg.company_id
        )
    ) THEN
        RAISE EXCEPTION 'Orphaned journal_entry_id found in purch_grn';
    END IF;

    -- Orphans in company_settings
    IF EXISTS (
        SELECT 1 FROM company_settings cs
        WHERE (cs.inventory_account_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM accounts a WHERE a.id = cs.inventory_account_id AND a.company_id = cs.company_id
        ))
        OR (cs.purchases_clearing_account_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM accounts a WHERE a.id = cs.purchases_clearing_account_id AND a.company_id = cs.company_id
        ))
    ) THEN
        RAISE EXCEPTION 'Orphaned account_id found in company_settings';
    END IF;
END $$;

-- 2. Drop OLD single-column FKs
ALTER TABLE purch_grn DROP CONSTRAINT IF EXISTS purch_grn_journal_entry_id_fkey;
ALTER TABLE company_settings DROP CONSTRAINT IF EXISTS company_settings_inventory_account_id_fkey;
ALTER TABLE company_settings DROP CONSTRAINT IF EXISTS company_settings_purchases_clearing_account_id_fkey;

-- 3. Add composite FKs
ALTER TABLE purch_grn
    ADD CONSTRAINT purch_grn_journal_entry_id_company_id_fkey
    FOREIGN KEY (journal_entry_id, company_id)
    REFERENCES journal_entries (id, company_id)
    ON DELETE RESTRICT;

ALTER TABLE company_settings
    ADD CONSTRAINT company_settings_inventory_account_id_company_id_fkey
    FOREIGN KEY (inventory_account_id, company_id)
    REFERENCES accounts (id, company_id)
    ON DELETE SET NULL;

ALTER TABLE company_settings
    ADD CONSTRAINT company_settings_purchases_clearing_account_id_company_id_fkey
    FOREIGN KEY (purchases_clearing_account_id, company_id)
    REFERENCES accounts (id, company_id)
    ON DELETE SET NULL;
