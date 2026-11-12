-- ==============================================================================
-- Migration 027: Configuration Platform Registry (Wave A / AN-CONFIG-REGISTRY-A2-1)
--
-- 1. config_definitions : global catalog of customization points (UNIQUE key).
-- 2. config_registry    : immutable published snapshots per company (versioned).
-- 3. config_drafts      : mutable work-in-progress state (one draft per company+definition).
-- 4. Immutability trigger on config_registry (content/version are immutable;
--    only is_active flips are permitted; DELETE is blocked to preserve audit).
-- 5. RLS: ENABLE + FORCE on all three tables; tenant isolation for registry/drafts.
-- 6. Least-privilege grants for role an_app; revokes from anon/authenticated/PUBLIC.
--
-- Design source: docs/foundation/configuration-platform/03-DATA-MODEL-DRAFT.md
-- ==============================================================================

-- 1. Config Definitions (global catalog, not company-scoped)
CREATE TABLE IF NOT EXISTS config_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(200) UNIQUE NOT NULL,
  schema JSONB NOT NULL CHECK (jsonb_typeof(schema) = 'object'),
  default_value JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(default_value) = 'object'),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Config Registry (immutable published snapshots, company-scoped)
CREATE TABLE IF NOT EXISTS config_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  config_definition_id UUID NOT NULL REFERENCES config_definitions(id) ON DELETE RESTRICT,
  version_no INT NOT NULL CHECK (version_no >= 1),
  is_active BOOLEAN NOT NULL DEFAULT false,
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  change_summary TEXT NOT NULL,
  published_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, config_definition_id, version_no)
);

-- Only one active version per company + definition
CREATE UNIQUE INDEX IF NOT EXISTS uq_config_registry_one_active
  ON config_registry (company_id, config_definition_id) WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_config_registry_company_def
  ON config_registry (company_id, config_definition_id, version_no DESC);

-- 3. Config Drafts (mutable WIP, one per company + definition)
CREATE TABLE IF NOT EXISTS config_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  config_definition_id UUID NOT NULL REFERENCES config_definitions(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review')),
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  updated_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, config_definition_id)
);

-- 4. Immutability trigger: published registry rows never change content/version;
--    only is_active may flip. DELETE is blocked to preserve audit history.
CREATE OR REPLACE FUNCTION trg_fn_config_registry_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CONFIG_REGISTRY_IMMUTABLE: published configuration versions cannot be deleted (audit history is preserved)';
  END IF;

  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.config_definition_id IS DISTINCT FROM OLD.config_definition_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.change_summary IS DISTINCT FROM OLD.change_summary
     OR NEW.published_by IS DISTINCT FROM OLD.published_by
     OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'CONFIG_REGISTRY_IMMUTABLE: published configuration content is immutable. Publish a new version_no instead (rollback = publish a copy of a known good state).';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_config_registry_immutability ON config_registry;
CREATE TRIGGER trg_config_registry_immutability
  BEFORE UPDATE OR DELETE ON config_registry
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_config_registry_immutability();

-- 5. Row Level Security (ENABLE + FORCE, matching 013 convention)
ALTER TABLE config_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_definitions FORCE ROW LEVEL SECURITY;

ALTER TABLE config_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_registry FORCE ROW LEVEL SECURITY;

ALTER TABLE config_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_drafts FORCE ROW LEVEL SECURITY;

-- 6. Policies for role an_app
-- config_definitions is a global/shared catalog (same treatment as `companies`)
DROP POLICY IF EXISTS config_definitions_app_policy ON config_definitions;
CREATE POLICY config_definitions_app_policy ON config_definitions
  TO an_app
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS config_registry_tenant_isolation ON config_registry;
CREATE POLICY config_registry_tenant_isolation ON config_registry
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS config_drafts_tenant_isolation ON config_drafts;
CREATE POLICY config_drafts_tenant_isolation ON config_drafts
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 7. Least-privilege grants
-- Definitions: catalog management (no DELETE — catalog keys are stable)
GRANT SELECT, INSERT, UPDATE ON config_definitions TO an_app;
-- Registry: publish/rollback flow (UPDATE is restricted to is_active flips by trigger; no DELETE)
GRANT SELECT, INSERT, UPDATE ON config_registry TO an_app;
-- Drafts: full draft lifecycle
GRANT SELECT, INSERT, UPDATE, DELETE ON config_drafts TO an_app;

-- 8. Revoke untrusted public/anon/authenticated grants
REVOKE ALL ON config_definitions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON config_registry FROM PUBLIC, anon, authenticated;
REVOKE ALL ON config_drafts FROM PUBLIC, anon, authenticated;

-- 9. Seed baseline definitions (idempotent). Content engines read these keys.
INSERT INTO config_definitions (key, schema, default_value, description) VALUES
  (
    'system.general',
    '{"type":"object","additionalProperties":true}'::jsonb,
    '{}'::jsonb,
    'General company-level configuration namespace (free-form object).'
  ),
  (
    'accounting.grn_mapping',
    '{"type":"object","additionalProperties":false,"properties":{"inventory_account_id":{"type":"string"},"purchases_clearing_account_id":{"type":"string"}},"required":["inventory_account_id","purchases_clearing_account_id"]}'::jsonb,
    '{"inventory_account_id":"","purchases_clearing_account_id":""}'::jsonb,
    'Mapping of the GRN posting event to GL accounts (consumed by the posting flow; referential integrity validated by the A4 engine).'
  )
ON CONFLICT (key) DO NOTHING;
