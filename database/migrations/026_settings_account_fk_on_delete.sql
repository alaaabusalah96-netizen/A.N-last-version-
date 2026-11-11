-- Migration 026: Fix Company Settings Composite FK ON DELETE Semantics
-- Multi-column FK containing non-nullable company_id cannot use plain ON DELETE SET NULL.
-- It must specify the column(s) to be set to NULL.

-- 1. Drop existing flawed constraints from 025
ALTER TABLE company_settings DROP CONSTRAINT IF EXISTS company_settings_inventory_account_id_company_id_fkey;
ALTER TABLE company_settings DROP CONSTRAINT IF EXISTS company_settings_purchases_clearing_account_id_company_id_fkey;

-- 2. Re-add with column-specific action (rational same as migration 017)
ALTER TABLE company_settings
    ADD CONSTRAINT company_settings_inventory_account_id_company_id_fkey
    FOREIGN KEY (inventory_account_id, company_id)
    REFERENCES accounts (id, company_id)
    ON DELETE SET NULL (inventory_account_id);

ALTER TABLE company_settings
    ADD CONSTRAINT company_settings_purchases_clearing_account_id_company_id_fkey
    FOREIGN KEY (purchases_clearing_account_id, company_id)
    REFERENCES accounts (id, company_id)
    ON DELETE SET NULL (purchases_clearing_account_id);
