-- ==============================================================================
-- Migration 039: Cash Receipt & Payment Vouchers (سندات القبض والصرف)
-- توثيق التعيين مع docs/foundation/MODULE_BOUNDARIES.md §3:
--   receipt_vouchers -> cash_receipt_vouchers
--   payment_vouchers -> cash_payment_vouchers
--   (تمت إضافة البادئة cash_ لتتطابق مع باقي جداول وحدة الخزينة cash_registers)
-- ==============================================================================

-- (أ) cash_receipt_vouchers — سندات القبض النقدية
CREATE TABLE IF NOT EXISTS cash_receipt_vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  voucher_no VARCHAR(50) NULL,
  register_id UUID NOT NULL,
  voucher_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  contra_account_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  memo TEXT NULL,
  reference TEXT NULL,
  journal_entry_id UUID NULL,
  posted_at TIMESTAMPTZ NULL,
  posted_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cash_receipt_vouchers_company_no UNIQUE (company_id, voucher_no),
  CONSTRAINT uq_cash_receipt_vouchers_company_id_id UNIQUE (company_id, id),
  CONSTRAINT fk_cash_receipt_vouchers_register_company
    FOREIGN KEY (register_id, company_id) REFERENCES cash_registers(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_receipt_vouchers_contra_company
    FOREIGN KEY (contra_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_receipt_vouchers_je_company
    FOREIGN KEY (journal_entry_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_cash_receipt_vouchers_company_status
  ON cash_receipt_vouchers (company_id, status);
CREATE INDEX IF NOT EXISTS idx_cash_receipt_vouchers_company_reg_date
  ON cash_receipt_vouchers (company_id, register_id, voucher_date DESC);

-- (ب) cash_payment_vouchers — سندات الصرف النقدية العامة
-- contra_account_id NOT NULL صريح لأن غياب الطرف المدين خطأ محاسبي لا حالة أعمال
CREATE TABLE IF NOT EXISTS cash_payment_vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  voucher_no VARCHAR(50) NULL,
  register_id UUID NOT NULL,
  voucher_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  contra_account_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  memo TEXT NULL,
  reference TEXT NULL,
  journal_entry_id UUID NULL,
  posted_at TIMESTAMPTZ NULL,
  posted_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cash_payment_vouchers_company_no UNIQUE (company_id, voucher_no),
  CONSTRAINT uq_cash_payment_vouchers_company_id_id UNIQUE (company_id, id),
  CONSTRAINT fk_cash_payment_vouchers_register_company
    FOREIGN KEY (register_id, company_id) REFERENCES cash_registers(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_payment_vouchers_contra_company
    FOREIGN KEY (contra_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_payment_vouchers_je_company
    FOREIGN KEY (journal_entry_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_cash_payment_vouchers_company_status
  ON cash_payment_vouchers (company_id, status);
CREATE INDEX IF NOT EXISTS idx_cash_payment_vouchers_company_reg_date
  ON cash_payment_vouchers (company_id, register_id, voucher_date DESC);

-- (ج) تفعيل وفرض RLS + GRANT + REVOKE للجدولين بنفس نمط 038 حرفيًا
ALTER TABLE cash_receipt_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_receipt_vouchers FORCE ROW LEVEL SECURITY;
ALTER TABLE cash_payment_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_payment_vouchers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cash_receipt_vouchers_tenant_isolation ON cash_receipt_vouchers;
CREATE POLICY cash_receipt_vouchers_tenant_isolation ON cash_receipt_vouchers
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS cash_payment_vouchers_tenant_isolation ON cash_payment_vouchers;
CREATE POLICY cash_payment_vouchers_tenant_isolation ON cash_payment_vouchers
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON cash_receipt_vouchers TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cash_payment_vouchers TO an_app;

REVOKE ALL ON cash_receipt_vouchers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON cash_payment_vouchers FROM PUBLIC, anon, authenticated;

-- (د) تسجيل تعريف إعداد مستقل للحدث (idempotent، بلا تعديل صفوف قائمة)
INSERT INTO config_definitions (key, domain, label_ar, is_system, schema, default_value, description)
VALUES (
  'accounting.cash_voucher_mapping',
  'accounting',
  'ربط سندات القبض والصرف بالدليل',
  true,
  '{"type":"object","additionalProperties":false,"properties":{}}'::jsonb,
  '{}'::jsonb,
  'إعلان مسار ترحيل سندات القبض والصرف المحاسبي (الحسابان يُحددان مباشرةً من الصندوق والطرف في السند)'
)
ON CONFLICT (key) DO NOTHING;
