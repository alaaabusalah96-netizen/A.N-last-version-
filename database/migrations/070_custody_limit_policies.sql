-- Migration 070: per-employee custody ceiling (AN-ERP custody step D2)
-- A company may cap the total custody an employee can hold at one time (pending + approved + open, net of settlements).
-- employee_user_id NULL is the company default. A per-employee row overrides it. The latest version of each scope wins.
-- enabled = false switches that scope off. For an employee row it EXEMPTS the employee even if the company default is on. Nothing is enforced until a policy is published.
-- Append-only (versioned), tenant RLS, no UPDATE or DELETE. Additive: no existing table or row is changed.
CREATE TABLE IF NOT EXISTS custody_limit_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  employee_user_id UUID NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  enabled BOOLEAN NOT NULL,
  limit_amount NUMERIC(15,2) NULL CHECK (limit_amount IS NULL OR limit_amount > 0),
  reason TEXT NULL,
  created_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_custody_limit_enabled_needs_amount CHECK (NOT enabled OR limit_amount IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custody_limit_policies_scope_version
  ON custody_limit_policies (company_id, COALESCE(employee_user_id, '00000000-0000-0000-0000-000000000000'::uuid), version);
CREATE INDEX IF NOT EXISTS idx_custody_limit_policies_lookup ON custody_limit_policies (company_id, employee_user_id, version DESC);

DO $do$
DECLARE t TEXT := 'custody_limit_policies';
BEGIN
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
END
$do$;
