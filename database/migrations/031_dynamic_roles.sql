-- ==============================================================================
-- Migration 031: Dynamic Roles & Permission Matrix (B2/B3)
-- الأدوار تتحول من تعريف ثابت في الكود إلى بيانات شركة، مع الحفاظ على
-- company_memberships.role النصي كتوافق خلفي (لا كسر لأي كود قائم).
-- ==============================================================================

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,
  name_ar VARCHAR(150) NOT NULL,
  description TEXT,
  org_level VARCHAR(20) NOT NULL DEFAULT 'company'
    CHECK (org_level IN ('company', 'branch', 'department')),
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_roles_company_code UNIQUE (company_id, code),
  CONSTRAINT chk_roles_code_format CHECK (code ~ '^[a-z][a-z0-9_]*$')
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code VARCHAR(80) NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_code)
);

CREATE INDEX IF NOT EXISTS idx_roles_company ON roles(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);

-- ربط العضوية بالدور الجديد (إضافي، nullable، لا يكسر أي مسار قائم)
ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS role_id UUID NULL
  REFERENCES roles(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_memberships_role ON company_memberships(role_id);

-- تقييد النص القديم: يمنع أي قيمة عشوائية جديدة
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_membership_role_text') THEN
    ALTER TABLE company_memberships
      ADD CONSTRAINT chk_membership_role_text
      CHECK (role IN ('platform_admin', 'company_admin', 'company_user'));
  END IF;
END $$;

-- RLS على الأدوار (بند الشركة)، والمصفوفة تتبع الدور
-- ملاحظة: النمط يطابق migration 027 بالكامل: TO an_app + NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS roles_tenant_isolation ON roles;
CREATE POLICY roles_tenant_isolation ON roles
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS role_permissions_tenant_isolation ON role_permissions;
CREATE POLICY role_permissions_tenant_isolation ON role_permissions
  TO an_app
  USING (EXISTS (
    SELECT 1 FROM roles r
    WHERE r.id = role_permissions.role_id
      AND r.company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM roles r
    WHERE r.id = role_permissions.role_id
      AND r.company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON role_permissions TO an_app;
REVOKE ALL ON roles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON role_permissions FROM PUBLIC, anon, authenticated;

-- زرع 3 أدوار نظامية لكل شركة قائمة (idempotent)، بلا صلاحيات بعد:
-- الصلاحيات تُزرع في الخدمة (WP-2) من ROLE_PERMISSIONS، مش في SQL،
-- لأن مصدر الحقيقة الواحد هو roles.ts وقت الترحيل.
INSERT INTO roles (company_id, code, name_ar, org_level, is_system)
SELECT c.id, v.code, v.name_ar, 'company', true
FROM companies c
CROSS JOIN (VALUES
  ('platform_admin', 'مدير منصة'),
  ('company_admin', 'مدير شركة'),
  ('company_user', 'مستخدم')
) AS v(code, name_ar)
ON CONFLICT (company_id, code) DO NOTHING;
