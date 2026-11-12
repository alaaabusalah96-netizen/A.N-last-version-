-- 028_grn_unit_cost_guard.sql
-- حماية تكلفة بنود سند الاستلام على مستوى قاعدة البيانات.
-- الفحص في الخدمة لا يكفي: أي مسار كتابة آخر لازم يخضع لنفس القيد.

-- 1) فحص بيانات موجودة قبل إضافة القيد (يفشل بصوت عالٍ لو فيه تكلفة سالبة)
DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT count(*) INTO bad_count
  FROM purch_grn_lines
  WHERE unit_cost IS NOT NULL AND unit_cost < 0;

  IF bad_count > 0 THEN
    RAISE EXCEPTION 'GRN_UNIT_COST_NEGATIVE: % rows in purch_grn_lines have negative unit_cost. Fix data before applying 028.', bad_count;
  END IF;
END $$;

-- 2) القيد نفسه
ALTER TABLE purch_grn_lines
  DROP CONSTRAINT IF EXISTS chk_purch_grn_lines_unit_cost_nonneg;

ALTER TABLE purch_grn_lines
  ADD CONSTRAINT chk_purch_grn_lines_unit_cost_nonneg
  CHECK (unit_cost IS NULL OR unit_cost >= 0);

COMMENT ON CONSTRAINT chk_purch_grn_lines_unit_cost_nonneg ON purch_grn_lines
  IS 'AN-CORE-CLOSURE-1 WP-3: unit_cost must never be negative. Positive-per-line is enforced in grnService.postGrn.';
