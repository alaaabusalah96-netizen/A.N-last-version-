-- ==============================================================================
-- Migration 030: Config Definition Catalog — تصنيف وتسمية وحماية المفتاح
-- لا يغيّر أي بيانات قائمة؛ يضيف أعمدة وقيود فقط.
-- ==============================================================================

ALTER TABLE config_definitions ADD COLUMN IF NOT EXISTS domain VARCHAR(60);
ALTER TABLE config_definitions ADD COLUMN IF NOT EXISTS label_ar VARCHAR(200);
ALTER TABLE config_definitions ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

-- تصنيف الموجود (idempotent): مفتاحان فقط على 616ebf9
UPDATE config_definitions SET domain = 'system', label_ar = COALESCE(label_ar, 'إعدادات عامة')
  WHERE key = 'system.general' AND domain IS NULL;
UPDATE config_definitions SET domain = 'accounting', label_ar = COALESCE(label_ar, 'ربط استلام البضائع بالدليل')
  WHERE key = 'accounting.grn_mapping' AND domain IS NULL;

-- أي تعريف بلا مجال = 'general' (لا يترك NULL يقصف الواجهة)
UPDATE config_definitions SET domain = 'general' WHERE domain IS NULL;

ALTER TABLE config_definitions ALTER COLUMN domain SET NOT NULL;
ALTER TABLE config_definitions ALTER COLUMN domain SET DEFAULT 'general';

-- المفتاح ثابت بعد الإنشاء: منع أي محاولة تغيير شكل المفتاح
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_config_def_key_format'
  ) THEN
    ALTER TABLE config_definitions
      ADD CONSTRAINT chk_config_def_key_format
      CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_config_definitions_domain
  ON config_definitions (domain, key);
