-- ==============================================================================
-- Migration 086: Intercompany stock transfers between companies of one group (additive)
-- A transfer is shipped by the sender company (sender journal: debit intercompany receivable,
-- credit inventory, at cost) and received by the receiver company (receiver journal: debit
-- inventory, credit intercompany payable). Each leg runs in one transaction of its own company,
-- so a transfer that is shipped and not yet received is a real "in transit" state.
-- Currency and rate are stored explicitly on the transfer. Price basis is stored per transfer
-- ('cost' now; 'market' is reserved for finished goods and is not posted by this migration).
-- Rollback: DROP TABLE group_transfer_lines, group_transfers, company_intercompany_accounts;
--           and delete the 086 row from schema_migrations.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS company_intercompany_accounts (
  company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  receivable_account_id UUID,
  payable_account_id UUID,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no BIGINT GENERATED ALWAYS AS IDENTITY,
  group_id UUID NOT NULL REFERENCES company_groups(id) ON DELETE RESTRICT,
  from_company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  to_company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  from_warehouse_id UUID NOT NULL,
  to_warehouse_id UUID, -- chosen by the receiving company when it receives
  status VARCHAR(20) NOT NULL DEFAULT 'shipped' CHECK (status IN ('shipped', 'received', 'received_short')),
  price_basis VARCHAR(10) NOT NULL DEFAULT 'cost' CHECK (price_basis IN ('cost', 'market')),
  from_currency VARCHAR(10) NOT NULL,
  to_currency VARCHAR(10) NOT NULL,
  fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  reference TEXT NOT NULL,
  memo TEXT,
  shipped_by UUID,
  shipped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by UUID,
  received_at TIMESTAMPTZ,
  CONSTRAINT chk_group_transfers_distinct CHECK (from_company_id <> to_company_id)
);
CREATE INDEX IF NOT EXISTS idx_group_transfers_from ON group_transfers (from_company_id, shipped_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_transfers_reference ON group_transfers (from_company_id, reference);
CREATE INDEX IF NOT EXISTS idx_group_transfers_to ON group_transfers (to_company_id, shipped_at DESC);

CREATE TABLE IF NOT EXISTS group_transfer_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES group_transfers(id) ON DELETE CASCADE,
  from_item_id UUID NOT NULL,
  to_item_id UUID NOT NULL,
  item_code VARCHAR(100) NOT NULL,
  qty_shipped NUMERIC(18,4) NOT NULL CHECK (qty_shipped > 0),
  unit_cost NUMERIC(18,6) NOT NULL,
  total_cost NUMERIC(18,4) NOT NULL,
  qty_received NUMERIC(18,4) CHECK (qty_received IS NULL OR qty_received >= 0),
  received_unit_cost NUMERIC(18,6),
  ship_journal_id UUID,
  receive_journal_id UUID
);
CREATE INDEX IF NOT EXISTS idx_group_transfer_lines_transfer ON group_transfer_lines (transfer_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['group_transfers', 'group_transfer_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_app_policy', t);
    EXECUTE format('CREATE POLICY %I ON %I TO an_app USING (true) WITH CHECK (true)', t || '_app_policy', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO an_app', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, anon, authenticated', t);
  END LOOP;
END $$;

ALTER TABLE company_intercompany_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_intercompany_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_intercompany_accounts_tenant_isolation ON company_intercompany_accounts;
CREATE POLICY company_intercompany_accounts_tenant_isolation ON company_intercompany_accounts
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON company_intercompany_accounts TO an_app;
REVOKE ALL ON company_intercompany_accounts FROM PUBLIC, anon, authenticated;
