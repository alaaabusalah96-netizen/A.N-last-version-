-- ==============================================================================
-- Migration 087: Accounting standards engine, step A+B (additive)
-- A: accounting_frameworks (catalog) + company_accounting_profiles (per company framework + country,
--    append-only history with valid_from).
-- B: accounting_policies (catalog): versioned policy values per framework/country with valid_from/valid_to
--    (valid_from stays NULL while the effective date is not verified; such a row can never be ACTIVE).
--    Append-only: rows are never deleted; the only allowed update is closing a version (valid_to, status).
-- No journal or posting path reads these tables yet. No rule or date is asserted by the seed:
-- every policy starts as DRAFT until a verified source reference is attached.
-- Rollback: DROP TABLE accounting_policies, company_accounting_profiles, accounting_frameworks;
--           DROP FUNCTION accounting_append_only_guard(); delete the 087 row from schema_migrations.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS accounting_frameworks (
  code VARCHAR(30) PRIMARY KEY,
  name_ar VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('international', 'country')),
  country_code VARCHAR(2),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO accounting_frameworks (code, name_ar, name_en, kind, country_code) VALUES
  ('IFRS', 'المعايير الدولية للتقرير المالي', 'IFRS Accounting Standards', 'international', NULL),
  ('IFRS_SME', 'المعيار الدولي للمنشآت الصغيرة والمتوسطة', 'IFRS for SMEs', 'international', NULL),
  ('EAS', 'معايير المحاسبة المصرية', 'Egyptian Accounting Standards', 'country', 'EG'),
  ('TAX', 'القواعد الضريبية المصرية', 'Egyptian tax rules', 'country', 'EG')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS company_accounting_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  framework_code VARCHAR(30) NOT NULL REFERENCES accounting_frameworks(code),
  country_code VARCHAR(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  valid_from DATE NOT NULL,
  note TEXT,
  created_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_company_accounting_profile_from UNIQUE (company_id, valid_from)
);
CREATE INDEX IF NOT EXISTS idx_company_accounting_profiles_company ON company_accounting_profiles(company_id, valid_from DESC);

CREATE TABLE IF NOT EXISTS accounting_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_key VARCHAR(80) NOT NULL,
  framework_code VARCHAR(30) NOT NULL REFERENCES accounting_frameworks(code),
  country_code VARCHAR(2),
  standard_ref VARCHAR(40) NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  valid_from DATE,
  valid_to DATE,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED')),
  source_reference TEXT,
  source_verified BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_accounting_policy_version UNIQUE (policy_key, framework_code, country_code, version),
  CONSTRAINT ck_accounting_policy_window CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT ck_accounting_policy_active_needs_source CHECK (status NOT IN ('ACTIVE') OR (source_verified AND COALESCE(TRIM(source_reference), '') <> '' AND valid_from IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_accounting_policies_lookup ON accounting_policies(policy_key, framework_code, valid_from DESC);

-- Append-only: no deletes; updates may only change valid_to and status (closing a version).
CREATE OR REPLACE FUNCTION accounting_append_only_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting_policies is append-only: delete not allowed';
  END IF;
  IF TG_TABLE_NAME = 'company_accounting_profiles' THEN
    RAISE EXCEPTION 'company_accounting_profiles is append-only: update not allowed';
  END IF;
  IF (NEW.id, NEW.policy_key, NEW.framework_code, NEW.country_code, NEW.standard_ref, NEW.version, NEW.valid_from, NEW.value, NEW.source_reference, NEW.source_verified)
     IS DISTINCT FROM
     (OLD.id, OLD.policy_key, OLD.framework_code, OLD.country_code, OLD.standard_ref, OLD.version, OLD.valid_from, OLD.value, OLD.source_reference, OLD.source_verified) THEN
    RAISE EXCEPTION 'accounting_policies is append-only: only valid_to and status may change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounting_policies_append_only ON accounting_policies;
CREATE TRIGGER trg_accounting_policies_append_only BEFORE UPDATE OR DELETE ON accounting_policies
  FOR EACH ROW EXECUTE FUNCTION accounting_append_only_guard();
DROP TRIGGER IF EXISTS trg_company_accounting_profiles_append_only ON company_accounting_profiles;
CREATE TRIGGER trg_company_accounting_profiles_append_only BEFORE UPDATE OR DELETE ON company_accounting_profiles
  FOR EACH ROW EXECUTE FUNCTION accounting_append_only_guard();

-- Catalog tables: app role has the standard grants (verifyDbPrivileges convention); append-only is enforced by triggers.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounting_frameworks', 'accounting_policies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_app_policy', t);
    EXECUTE format('CREATE POLICY %I ON %I TO an_app USING (true) WITH CHECK (true)', t || '_app_policy', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_frameworks TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_policies TO an_app;
REVOKE ALL ON accounting_frameworks, accounting_policies FROM PUBLIC, anon, authenticated;

ALTER TABLE company_accounting_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_accounting_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_accounting_profiles_tenant_isolation ON company_accounting_profiles;
CREATE POLICY company_accounting_profiles_tenant_isolation ON company_accounting_profiles
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON company_accounting_profiles TO an_app;
REVOKE ALL ON company_accounting_profiles FROM PUBLIC, anon, authenticated;
