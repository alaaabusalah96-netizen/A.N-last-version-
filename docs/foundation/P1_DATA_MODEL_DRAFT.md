# P1 Data Model Draft (Logical Specification)

**Package**: AN-P1A-LEDGER-ORG-DESIGN-1  
**Status**: DRAFT SPECIFICATION ONLY (NO SQL EXECUTED)  
**Date**: 2026-11-08  

This document presents the target logical schema and constraints planned for the upcoming P1 implementation phases (P1b Ledger Guarantees & P1c Organizational Units).

---

## 1. New Table: `org_units` (P1c)

Represents departments, branches, cost centers, and regional divisions within a legal entity.

```sql
CREATE TABLE org_units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES org_units(id) ON DELETE RESTRICT,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    unit_type VARCHAR(30) NOT NULL, -- 'branch', 'department', 'cost_center', 'division'
    is_active BOOLEAN NOT NULL DEFAULT true,
    path TEXT NOT NULL DEFAULT '/',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_company_org_unit_code UNIQUE (company_id, code)
);

-- Indexes
CREATE INDEX idx_org_units_company_id ON org_units(company_id);
CREATE INDEX idx_org_units_parent_id ON org_units(parent_id);
CREATE INDEX idx_org_units_path ON org_units(path text_pattern_ops);
```

---

## 2. New Table: `user_org_scope` (P1c)

Authorizes users to operate inside specific organizational units.

```sql
CREATE TABLE user_org_scope (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    org_unit_id UUID NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
    access_level VARCHAR(20) NOT NULL DEFAULT 'read_write', -- 'read_only', 'read_write'
    include_descendants BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_company_org UNIQUE (user_id, company_id, org_unit_id)
);

CREATE INDEX idx_user_org_scope_user ON user_org_scope(user_id, company_id);
```

---

## 3. New Table: `accounting_sequences` (P1b)

Thread-safe monotonic sequence generator per company.

```sql
CREATE TABLE accounting_sequences (
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    series_key VARCHAR(50) NOT NULL, -- e.g. 'JE-2026'
    current_value BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, series_key)
);
```

---

## 4. New Table: `accounting_periods` (P1b)

Controls open/closed accounting periods to prevent unauthorized historical mutations.

```sql
CREATE TABLE accounting_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    fiscal_year INT NOT NULL,
    period_number INT NOT NULL, -- 1 to 12
    name VARCHAR(50) NOT NULL,  -- e.g. 'FY2026-M01'
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_closed BOOLEAN NOT NULL DEFAULT false,
    closed_at TIMESTAMPTZ,
    closed_by UUID REFERENCES platform_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_company_period UNIQUE (company_id, fiscal_year, period_number)
);

CREATE INDEX idx_accounting_periods_company_dates ON accounting_periods(company_id, start_date, end_date);
```

---

## 5. Extensions to Existing Accounting Tables (P1b & P1c)

### 5.1. `accounts` Table (Nullable Org Extension)
```sql
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS org_unit_id UUID REFERENCES org_units(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS is_reconciled BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_accounts_org_unit ON accounts(org_unit_id) WHERE org_unit_id IS NOT NULL;
```

### 5.2. `journal_entries` Table (Ledger Guarantees Extension)
```sql
ALTER TABLE journal_entries
    ADD COLUMN IF NOT EXISTS entry_number VARCHAR(50),
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'draft', -- 'draft', 'posted', 'voided'
    ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS posted_by UUID REFERENCES platform_users(id),
    ADD COLUMN IF NOT EXISTS reversed_entry_id UUID REFERENCES journal_entries(id),
    ADD COLUMN IF NOT EXISTS org_unit_id UUID REFERENCES org_units(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'EGP',
    ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(12, 6) NOT NULL DEFAULT 1.0;

-- Ensure entry numbers are unique per company once assigned
CREATE UNIQUE INDEX uq_journal_entries_company_number 
    ON journal_entries(company_id, entry_number) 
    WHERE entry_number IS NOT NULL;
```

### 5.3. `journal_lines` Table (Line Guarantees Extension)
```sql
ALTER TABLE journal_lines
    ADD COLUMN IF NOT EXISTS org_unit_id UUID REFERENCES org_units(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'EGP',
    ADD COLUMN IF NOT EXISTS amount_currency NUMERIC(18, 4) NOT NULL DEFAULT 0.0,
    ADD CONSTRAINT chk_line_non_negative_amounts CHECK (debit >= 0 AND credit >= 0),
    ADD CONSTRAINT chk_line_has_movement CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0));

CREATE INDEX idx_journal_lines_org_unit ON journal_lines(org_unit_id) WHERE org_unit_id IS NOT NULL;
```

---

## 6. Tenant RLS and Table Ownership Catalog Registration

All new tables (`org_units`, `user_org_scope`, `accounting_sequences`, `accounting_periods`) are classified as `tenant` scope. They will be registered in `database/table_ownership.json` with:
- `relforcerowsecurity = true`
- Policies granting operational access strictly to `an_app` where `company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid`.
