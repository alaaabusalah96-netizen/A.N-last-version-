-- ==============================================================================
-- Migration 033: تسجيل أحداث الربط المحاسبي الموصولة فقط.
-- لا يزرع تعريفات لعمليات غير منفذة (واجهة بلا أثر = مرفوضة).
-- ==============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM config_definitions WHERE key = 'accounting.grn_mapping') THEN
    RAISE EXCEPTION 'accounting.grn_mapping مفقود — 027 لم تُطبّق. الحزمة لا تكمل.';
  END IF;
END $$;

-- توحيد التصنيف للتسمية في الواجهة (لا تغيير في schema أو default_value)
UPDATE config_definitions
   SET domain = 'accounting',
       label_ar = COALESCE(label_ar, 'ربط استلام البضائع بالدليل المحاسبي'),
       is_system = true
 WHERE key = 'accounting.grn_mapping';

-- تعليم الحقلين بأنهما مراجع حسابات (وصفًا فقط، التحقق في الخدمة)
UPDATE config_definitions
   SET description = COALESCE(description, '') ||
       E'\nمراجع الحسابات: inventory_account_id (asset, postable), purchases_clearing_account_id (liability, postable)'
 WHERE key = 'accounting.grn_mapping';
