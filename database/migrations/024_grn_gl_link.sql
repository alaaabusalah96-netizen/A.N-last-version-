-- Migration 024: GRN-GL Linkage and Accounting Accounts in Company Settings

-- 1. Add journal_entry_id to purch_grn
ALTER TABLE purch_grn ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT;

-- 2. Add inventory and purchases clearing account IDs to company_settings
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS inventory_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS purchases_clearing_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
