-- Migration 062: Custody shortage settlement treatments (AN-ERP-C13)
-- A shortage claim is owed by the employee. Besides cash repayment (already built), a company can enable two more
-- treatments, each only when it is switched on and its account is mapped:
--   WRITE_OFF       Dr loss (cash short and over) expense / Cr custody receivable, after approval
--   PAYROLL_DEDUCT  Dr employee payroll receivable / Cr custody receivable, after approval (record for payroll)
-- Nothing is enabled by default. The manager chooses the treatment per case.
-- Approval goes through the generic approval engine (document type custody_shortage_settlement).
-- Everything is append-only: policies are versioned, a settlement is requested once, posting is a separate row.

CREATE TABLE IF NOT EXISTS custody_settlement_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  treatment TEXT NOT NULL CHECK (treatment IN ('WRITE_OFF','PAYROLL_DEDUCT')),
  version INTEGER NOT NULL CHECK (version >= 1),
  enabled BOOLEAN NOT NULL,
  account_id UUID NOT NULL,
  ceiling NUMERIC(15,2) NULL CHECK (ceiling IS NULL OR ceiling > 0),
  created_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_custody_settlement_policies_version UNIQUE (company_id, treatment, version),
  CONSTRAINT fk_custody_settlement_policies_account FOREIGN KEY (account_id, company_id)
    REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS custody_shortage_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  claim_id UUID NOT NULL,
  treatment TEXT NOT NULL CHECK (treatment IN ('WRITE_OFF','PAYROLL_DEDUCT')),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  requested_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_custody_shortage_settlements_id_company UNIQUE (id, company_id),
  CONSTRAINT fk_custody_shortage_settlements_claim FOREIGN KEY (claim_id, company_id)
    REFERENCES custody_shortage_claims(id, company_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS custody_shortage_settlement_postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  settlement_id UUID NOT NULL,
  journal_entry_id UUID NOT NULL,
  posted_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_custody_shortage_settlement_postings_one UNIQUE (settlement_id),
  CONSTRAINT fk_custody_shortage_settlement_postings_settlement FOREIGN KEY (settlement_id, company_id)
    REFERENCES custody_shortage_settlements(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_custody_shortage_settlement_postings_je FOREIGN KEY (journal_entry_id, company_id)
    REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_custody_settlement_policies_lookup ON custody_settlement_policies (company_id, treatment, version DESC);
CREATE INDEX IF NOT EXISTS idx_custody_shortage_settlements_claim ON custody_shortage_settlements (company_id, claim_id);

DO $do$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['custody_settlement_policies','custody_shortage_settlements','custody_shortage_settlement_postings'] LOOP
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
