-- ==============================================================================
-- Migration 034: الحقول الإضافية الديناميكية (C6) — التعريفات والقيم
-- الكيان الأول: item. الكيانات التانية تتضاف بحزمة تلمس نموذجها الحقيقي.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type VARCHAR(40) NOT NULL CHECK (entity_type IN ('item', 'supplier', 'customer', 'document')),
  field_key VARCHAR(60) NOT NULL,
  label_ar VARCHAR(150) NOT NULL,
  field_type VARCHAR(20) NOT NULL
    CHECK (field_type IN ('text', 'number', 'date', 'boolean', 'select')),
  options JSONB NULL,
  is_required BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  help_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_custom_field_entity_key UNIQUE (company_id, entity_type, field_key),
  CONSTRAINT chk_custom_field_key_format CHECK (field_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT chk_custom_field_select_options
    CHECK (field_type <> 'select' OR (options IS NOT NULL AND jsonb_typeof(options) = 'array'
           AND jsonb_array_length(options) > 0))
);

CREATE TABLE IF NOT EXISTS custom_field_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  field_id UUID NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL,
  value_text TEXT,
  value_number NUMERIC(18, 4),
  value_date DATE,
  value_boolean BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, field_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_cfv_entity ON custom_field_values (company_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_cfv_field ON custom_field_values (field_id);
CREATE INDEX IF NOT EXISTS idx_cfd_entity_type ON custom_field_definitions (company_id, entity_type, sort_order);

-- RLS مطابق بالحرف لنمط 027 / 031
ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE custom_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_values FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cfd_tenant ON custom_field_definitions;
CREATE POLICY cfd_tenant ON custom_field_definitions
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS cfv_tenant ON custom_field_values;
CREATE POLICY cfv_tenant ON custom_field_values
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_field_definitions TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_field_values TO an_app;
REVOKE ALL ON custom_field_definitions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON custom_field_values FROM PUBLIC, anon, authenticated;
