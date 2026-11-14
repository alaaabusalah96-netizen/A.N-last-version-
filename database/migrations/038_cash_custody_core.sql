-- ==============================================================================
-- Migration 038: Cash Registers & Employee Custody Core (الخزينة والعهد)
-- ثلاث جداول + عمود إعدادات + تعريف إعداد + RLS + صلاحيات an_app
-- ==============================================================================

-- (أ) cash_registers — الصناديق/الخزائن
CREATE TABLE IF NOT EXISTS cash_registers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,
  name_ar VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NULL,
  gl_account_id UUID NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  memo TEXT NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cash_registers_company_code UNIQUE (company_id, code),
  CONSTRAINT uq_cash_registers_company_id_id UNIQUE (company_id, id),
  CONSTRAINT fk_cash_registers_gl_account_company
    FOREIGN KEY (gl_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT uq_cash_registers_company_gl UNIQUE (company_id, gl_account_id)
);

CREATE INDEX IF NOT EXISTS idx_cash_registers_company_active
  ON cash_registers (company_id, is_active);

-- (ب) custody_records — العهد
CREATE TABLE IF NOT EXISTS custody_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  custody_no VARCHAR(50) NULL,
  employee_user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  register_id UUID NOT NULL,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  purpose TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','open','settled','cancelled')),
  request_date DATE NOT NULL DEFAULT CURRENT_DATE,
  requested_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  approved_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ NULL,
  rejected_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ NULL,
  reject_reason TEXT NULL,
  disbursed_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  disbursed_at TIMESTAMPTZ NULL,
  settled_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  settled_at TIMESTAMPTZ NULL,
  disburse_journal_entry_id UUID NULL,
  settle_journal_entry_id UUID NULL,
  settled_expense_total NUMERIC(15,2) NULL,
  settled_cash_return NUMERIC(15,2) NULL,
  memo TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_custody_records_company_id_id UNIQUE (company_id, id),
  CONSTRAINT uq_custody_records_company_no UNIQUE (company_id, custody_no),
  CONSTRAINT fk_custody_records_register_company
    FOREIGN KEY (register_id, company_id) REFERENCES cash_registers(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_custody_records_disburse_je_company
    FOREIGN KEY (disburse_journal_entry_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_custody_records_settle_je_company
    FOREIGN KEY (settle_journal_entry_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_custody_records_company_status
  ON custody_records (company_id, status);
CREATE INDEX IF NOT EXISTS idx_custody_records_company_emp_status
  ON custody_records (company_id, employee_user_id, status);
CREATE INDEX IF NOT EXISTS idx_custody_records_company_register
  ON custody_records (company_id, register_id);

-- (ج) custody_movements — حركات العهدة على الصندوق
CREATE TABLE IF NOT EXISTS custody_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  custody_id UUID NOT NULL,
  register_id UUID NOT NULL,
  movement_type VARCHAR(20) NOT NULL
    CHECK (movement_type IN ('disburse','settle_expense','settle_return','reverse')),
  direction VARCHAR(4) NOT NULL CHECK (direction IN ('out','in','none')),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  expense_account_id UUID NULL,
  journal_entry_id UUID NULL,
  memo TEXT NULL,
  created_by UUID NULL REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_custody_movements_custody_company
    FOREIGN KEY (custody_id, company_id) REFERENCES custody_records(id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_custody_movements_register_company
    FOREIGN KEY (register_id, company_id) REFERENCES cash_registers(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_custody_movements_expense_account_company
    FOREIGN KEY (expense_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT chk_custody_movements_expense_account
    CHECK (movement_type <> 'settle_expense' OR expense_account_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_custody_movements_company_reg_date
  ON custody_movements (company_id, register_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_custody_movements_company_custody
  ON custody_movements (company_id, custody_id);

-- (د) تفعيل وفرض RLS للجداول الثلاثة
ALTER TABLE cash_registers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_registers FORCE ROW LEVEL SECURITY;
ALTER TABLE custody_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE custody_records FORCE ROW LEVEL SECURITY;
ALTER TABLE custody_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE custody_movements FORCE ROW LEVEL SECURITY;

-- سياسات عزل المستأجر لدور an_app
DROP POLICY IF EXISTS cash_registers_tenant_isolation ON cash_registers;
CREATE POLICY cash_registers_tenant_isolation ON cash_registers
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS custody_records_tenant_isolation ON custody_records;
CREATE POLICY custody_records_tenant_isolation ON custody_records
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS custody_movements_tenant_isolation ON custody_movements;
CREATE POLICY custody_movements_tenant_isolation ON custody_movements
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- منح الصلاحيات لدور التطبيق an_app
GRANT SELECT, INSERT, UPDATE, DELETE ON cash_registers TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON custody_records TO an_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON custody_movements TO an_app;

-- سحب كافة الصلاحيات من الأدوار العامة
REVOKE ALL ON cash_registers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON custody_records FROM PUBLIC, anon, authenticated;
REVOKE ALL ON custody_movements FROM PUBLIC, anon, authenticated;

-- (هـ) company_settings: إضافة عمود الربط
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'company_settings' AND column_name = 'custody_receivable_account_id'
  ) THEN
    ALTER TABLE company_settings
      ADD COLUMN custody_receivable_account_id UUID NULL
      REFERENCES accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_settings_custody_account_company_fk'
  ) THEN
    ALTER TABLE company_settings
      ADD CONSTRAINT company_settings_custody_account_company_fk
      FOREIGN KEY (custody_receivable_account_id, company_id)
      REFERENCES accounts (id, company_id)
      ON DELETE SET NULL (custody_receivable_account_id);
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- (و) تسجيل تعريف إعداد الربط المحاسبي (accounting.custody_mapping)
INSERT INTO config_definitions (key, domain, label_ar, is_system, schema, default_value, description)
VALUES (
  'accounting.custody_mapping',
  'accounting',
  'ربط عهد الموظفين بالدليل',
  true,
  '{"type":"object","additionalProperties":false,"properties":{"custody_receivable_account_id":{"type":"string"}},"required":["custody_receivable_account_id"]}'::jsonb,
  '{"custody_receivable_account_id":""}'::jsonb,
  'ربط عهد الموظفين بالدليل المحاسبي (ذمة عهد الموظفين)'
)
ON CONFLICT (key) DO NOTHING;
