-- ==============================================================================
-- Migration 082: Physical stocktake sheets (additive)
-- A stocktake snapshots the system quantity per item for one warehouse; counters enter the
-- physical quantity; the variance is REPORTED only. Counting never posts to stock or the ledger
-- (adjustments stay a separate, permissioned action).
-- Rollback: DROP TABLE inv_stocktake_lines; DROP TABLE inv_stocktakes;
--           and delete the 082 row from schema_migrations.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS inv_stocktakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stocktake_no INTEGER NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES inv_warehouses(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'closed', 'cancelled')),
  count_date DATE NOT NULL DEFAULT CURRENT_DATE,
  memo TEXT,
  created_by UUID,
  closed_by UUID,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inv_stocktakes_company_id UNIQUE (company_id, id),
  CONSTRAINT uq_inv_stocktakes_company_no UNIQUE (company_id, stocktake_no)
);
CREATE INDEX IF NOT EXISTS idx_inv_stocktakes_company ON inv_stocktakes (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inv_stocktake_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stocktake_id UUID NOT NULL,
  item_id UUID NOT NULL REFERENCES inv_items(id) ON DELETE RESTRICT,
  system_qty NUMERIC(18,4) NOT NULL,
  counted_qty NUMERIC(18,4) CHECK (counted_qty IS NULL OR counted_qty >= 0),
  counted_by UUID,
  counted_at TIMESTAMPTZ,
  CONSTRAINT uq_inv_stocktake_lines_item UNIQUE (stocktake_id, item_id),
  CONSTRAINT fk_inv_stocktake_lines_stocktake
    FOREIGN KEY (company_id, stocktake_id) REFERENCES inv_stocktakes(company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_inv_stocktake_lines_stocktake ON inv_stocktake_lines (company_id, stocktake_id);

ALTER TABLE inv_stocktakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_stocktakes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inv_stocktakes_tenant_isolation ON inv_stocktakes;
CREATE POLICY inv_stocktakes_tenant_isolation ON inv_stocktakes
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_stocktakes TO an_app;
REVOKE ALL ON inv_stocktakes FROM PUBLIC, anon, authenticated;

ALTER TABLE inv_stocktake_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_stocktake_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inv_stocktake_lines_tenant_isolation ON inv_stocktake_lines;
CREATE POLICY inv_stocktake_lines_tenant_isolation ON inv_stocktake_lines
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON inv_stocktake_lines TO an_app;
REVOKE ALL ON inv_stocktake_lines FROM PUBLIC, anon, authenticated;
