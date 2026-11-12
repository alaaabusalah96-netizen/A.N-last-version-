-- ==============================================================================
-- Migration 032: ربط نطاقات المستخدم بالأدوار + سريان زمني + تفويض (B4 / AN-RBAC-SCOPES-6)
-- إضافي فقط: لا يغيّر أي صف قائم ولا أي دلالة قائمة.
-- ==============================================================================

ALTER TABLE user_org_scope ADD COLUMN IF NOT EXISTS role_id UUID NULL
  REFERENCES roles(id) ON DELETE SET NULL;
ALTER TABLE user_org_scope ADD COLUMN IF NOT EXISTS valid_from DATE NULL;
ALTER TABLE user_org_scope ADD COLUMN IF NOT EXISTS valid_until DATE NULL;
ALTER TABLE user_org_scope ADD COLUMN IF NOT EXISTS delegated_by UUID NULL
  REFERENCES platform_users(id) ON DELETE SET NULL;
ALTER TABLE user_org_scope ADD COLUMN IF NOT EXISTS reason TEXT;

DO $$
DECLARE
  r RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_scope_validity_range') THEN
    ALTER TABLE user_org_scope
      ADD CONSTRAINT chk_scope_validity_range
      CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from);
  END IF;

  -- Widen access_level CHECK constraint (014 allowed only 'read', 'write'; B4 requires 'approve' as well)
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'user_org_scope'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%access_level%'
      AND conname <> 'chk_user_org_scope_access_level'
  LOOP
    EXECUTE format('ALTER TABLE user_org_scope DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_org_scope_access_level') THEN
    ALTER TABLE user_org_scope
      ADD CONSTRAINT chk_user_org_scope_access_level
      CHECK (access_level IN ('read', 'write', 'approve'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scope_validity
  ON user_org_scope (company_id, user_id, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_scope_role
  ON user_org_scope (company_id, role_id);

-- عرض مساعد: النطاق الفعّال اليوم لكل مستخدم (يُستخدم في التقارير وفي التحقق)
-- يستخدم امتيازات المستعلم الحالي مع security_invoker = true (PostgreSQL 15+) لضمان تطبيق RLS لدور an_app
CREATE OR REPLACE VIEW v_user_effective_scopes AS
SELECT s.company_id, s.user_id, s.org_unit_id, s.include_descendants, s.access_level,
       s.role_id, s.valid_from, s.valid_until, s.delegated_by, s.reason, s.created_at,
       o.code AS org_unit_code, o.name_ar AS org_unit_name_ar,
       o.path AS org_unit_path, o.unit_type,
       r.code AS role_code
FROM user_org_scope s
JOIN org_units o ON o.id = s.org_unit_id
LEFT JOIN roles r ON r.id = s.role_id AND r.company_id = s.company_id
WHERE o.is_active = true
  AND (s.valid_from IS NULL OR s.valid_from <= CURRENT_DATE)
  AND (s.valid_until IS NULL OR s.valid_until >= CURRENT_DATE);

DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 150000 THEN
    EXECUTE 'ALTER VIEW v_user_effective_scopes SET (security_invoker = true)';
  END IF;
END $$;

GRANT SELECT ON v_user_effective_scopes TO an_app;
REVOKE ALL ON v_user_effective_scopes FROM PUBLIC, anon, authenticated;
