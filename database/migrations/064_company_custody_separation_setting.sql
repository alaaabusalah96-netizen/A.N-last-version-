-- Migration 064: configurable separation of duties for cash custody.
-- Default TRUE (enforced) for every company, including existing ones and platform admins.
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS enforce_custody_separation BOOLEAN NOT NULL DEFAULT TRUE;
