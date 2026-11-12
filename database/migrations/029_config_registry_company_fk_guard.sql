-- 029_config_registry_company_fk_guard.sql
-- إصلاح تعارض حقيقي:
--   config_registry.company_id فيه ON DELETE CASCADE
--   + Trigger CONFIG_REGISTRY_IMMUTABLE بيرفض أي DELETE على السطور
-- النتيجة: حذف شركة عندها إصدار منشور بيفشل بخطأ Trigger غامض.
--
-- القرار الهندسي: سجل الإصدارات المنشورة أثر تدقيقي لا يُحذف.
-- لذلك الشركة اللي عندها إصدارات منشورة لا يجوز حذفها حذفاً صلباً؛
-- نُبدّل CASCADE بـ RESTRICT ليصبح الخطأ صريحاً ومقصوداً.
-- أما المسودات فهي بيانات عمل قابلة للتغيير، فتظل CASCADE.

DO $$
DECLARE
  published_companies INTEGER;
BEGIN
  SELECT count(DISTINCT company_id) INTO published_companies FROM config_registry;
  RAISE NOTICE 'config_registry holds published versions for % company(ies); these companies will be protected from hard delete.', published_companies;
END $$;

-- 1) config_registry: CASCADE -> RESTRICT
ALTER TABLE config_registry
  DROP CONSTRAINT IF EXISTS config_registry_company_id_fkey;

ALTER TABLE config_registry
  ADD CONSTRAINT config_registry_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;

-- 2) config_drafts: نُثبّت CASCADE صريحاً (موجود أصلاً؛ إعادة التأكيد idempotent)
ALTER TABLE config_drafts
  DROP CONSTRAINT IF EXISTS config_drafts_company_id_fkey;

ALTER TABLE config_drafts
  ADD CONSTRAINT config_drafts_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

COMMENT ON CONSTRAINT config_registry_company_id_fkey ON config_registry
  IS 'AN-CORE-CLOSURE-1 WP-4: published configuration history is audit data; deleting a company with published versions must fail explicitly, not via trigger noise.';
