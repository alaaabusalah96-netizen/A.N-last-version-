-- ==============================================================================
-- Migration 035: Enforce Same-Company Role Foreign Keys (AN-FIX-RBAC-FK-11)
-- يفرض تطابق company_id بين الدور والعضوية/النطاق على مستوى قاعدة البيانات.
-- ==============================================================================

-- 1. WP-2: معالجة البيانات القديمة قبل القيد
-- أي role_id يشير لدور شركة أخرى أو دور غير موجود يُصفَّر إلى NULL (مسار التوافق القديم)
-- دون حذف أي صف ودون تغيير في الصلاحيات الفعلية.
UPDATE company_memberships cm
SET role_id = NULL
WHERE cm.role_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM roles r
    WHERE r.id = cm.role_id
      AND r.company_id = cm.company_id
  );

UPDATE user_org_scope uos
SET role_id = NULL
WHERE uos.role_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM roles r
    WHERE r.id = uos.role_id
      AND r.company_id = uos.company_id
  );

-- 2. WP-1a: قيد وفهرس فريد uq_roles_company_id ON roles(company_id, id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_roles_company_id'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'uq_roles_company_id'
        AND c.relkind = 'i'
    ) THEN
      ALTER TABLE roles
        ADD CONSTRAINT uq_roles_company_id UNIQUE USING INDEX uq_roles_company_id;
    ELSE
      ALTER TABLE roles
        ADD CONSTRAINT uq_roles_company_id UNIQUE (company_id, id);
    END IF;
  END IF;
END $$;

-- 3. إزالة القيود الأحادية القديمة على role_id وإضافة القيود المركبة (ON DELETE RESTRICT)
DO $$
DECLARE
  r RECORD;
BEGIN
  -- إزالة أي FK سابق من company_memberships إلى roles عدا القيد المركب الجديد
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'company_memberships'::regclass
      AND contype = 'f'
      AND confrelid = 'roles'::regclass
      AND conname <> 'fk_memberships_role_same_company'
  LOOP
    EXECUTE format('ALTER TABLE company_memberships DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  -- إزالة أي FK سابق من user_org_scope إلى roles عدا القيد المركب الجديد
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'user_org_scope'::regclass
      AND contype = 'f'
      AND confrelid = 'roles'::regclass
      AND conname <> 'fk_user_org_scope_role_same_company'
  LOOP
    EXECUTE format('ALTER TABLE user_org_scope DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  -- WP-1b: قيد مركب على company_memberships(company_id, role_id) -> roles(company_id, id) ON DELETE RESTRICT
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_memberships_role_same_company'
  ) THEN
    ALTER TABLE company_memberships
      ADD CONSTRAINT fk_memberships_role_same_company
      FOREIGN KEY (company_id, role_id)
      REFERENCES roles (company_id, id)
      ON DELETE RESTRICT;
  END IF;

  -- WP-1c: قيد مركب على user_org_scope(company_id, role_id) -> roles(company_id, id) ON DELETE RESTRICT
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_org_scope_role_same_company'
  ) THEN
    ALTER TABLE user_org_scope
      ADD CONSTRAINT fk_user_org_scope_role_same_company
      FOREIGN KEY (company_id, role_id)
      REFERENCES roles (company_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;
