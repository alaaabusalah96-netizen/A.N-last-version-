-- Migration 060: Custody shortage claims (AN-ERP-R08-P2A2)
-- A cash count that finds less cash than expected can be turned into a claim owed by the employee.
-- Nothing posts when the claim is created: the custody receivable already shows the employee owes it.
-- The employee repays in cash (Dr cash / Cr custody receivable). History is append-only.
-- The outstanding amount is derived (claim amount minus repayments), never stored or edited.

ALTER TABLE custody_movements DROP CONSTRAINT IF EXISTS custody_movements_movement_type_check;
ALTER TABLE custody_movements ADD CONSTRAINT custody_movements_movement_type_check
  CHECK (movement_type IN ('disburse','topup','settle_expense','settle_return','reverse','shortage_repay'));

-- Needed so a count can be referenced with a company-safe composite key.
ALTER TABLE custody_cash_counts DROP CONSTRAINT IF EXISTS uq_custody_cash_counts_id_company;
ALTER TABLE custody_cash_counts ADD CONSTRAINT uq_custody_cash_counts_id_company UNIQUE (id, company_id);

CREATE TABLE IF NOT EXISTS custody_shortage_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  custody_id UUID NOT NULL,
  cash_count_id UUID NOT NULL,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  memo TEXT NULL,
  created_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_custody_shortage_claims_id_company UNIQUE (id, company_id),
  CONSTRAINT uq_custody_shortage_claims_one_per_count UNIQUE (cash_count_id),
  CONSTRAINT fk_custody_shortage_claims_custody FOREIGN KEY (custody_id, company_id)
    REFERENCES custody_records(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_custody_shortage_claims_count FOREIGN KEY (cash_count_id, company_id)
    REFERENCES custody_cash_counts(id, company_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS custody_shortage_repayments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  claim_id UUID NOT NULL,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  journal_entry_id UUID NOT NULL,
  memo TEXT NULL,
  created_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_custody_shortage_repayments_claim FOREIGN KEY (claim_id, company_id)
    REFERENCES custody_shortage_claims(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_custody_shortage_repayments_je FOREIGN KEY (journal_entry_id, company_id)
    REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_custody_shortage_claims_company_custody ON custody_shortage_claims (company_id, custody_id);
CREATE INDEX IF NOT EXISTS idx_custody_shortage_repayments_claim ON custody_shortage_repayments (company_id, claim_id);

DO $do$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['custody_shortage_claims','custody_shortage_repayments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format($p$CREATE POLICY %I ON %I TO an_app
      USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)$p$, t || '_tenant_isolation', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO an_app', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('CREATE OR REPLACE FUNCTION %I() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION ''%s rows are immutable (history is kept)''; END; $f$ LANGUAGE plpgsql', t || '_guard', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || t || '_guard', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION %I()', 'trg_' || t || '_guard', t, t || '_guard');
  END LOOP;
END
$do$;
