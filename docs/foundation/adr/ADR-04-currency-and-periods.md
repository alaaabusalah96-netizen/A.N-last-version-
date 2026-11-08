# ADR-04: Currency Handling and Accounting Periods

- **Status**: APPROVED (Design Phase)
- **Context**: P1 Architecture Foundations (AN-P1A-LEDGER-ORG-DESIGN-1)
- **Date**: 2026-11-08
- **Author**: Platform Architecture Team

---

## 1. Context and Problem Statement
Financial ledgers require explicit definition of monetary precision, base functional currency, foreign transaction currencies, and closed/open fiscal periods to maintain audit compliance and prevent post-closing balance changes.

---

## 2. Currency Handling Strategy

### 2.1. Functional Currency
- The base/functional currency for all general ledger accounts in a company is defined in `company_settings.default_currency_code` (e.g. `EGP`, `USD`, `SAR`).
- All ledger lines record amounts in the company's functional currency as primary storage (`NUMERIC(18, 4)` for high calculation precision, formatted to 2 decimal places for reporting).

### 2.2. Multi-Currency Stance for P1
- **Phase 1 (P1b)**: Single functional currency ledger.
  - Transactions are posted in the company's default currency.
  - Columns `currency_code` and `exchange_rate` are introduced on `journal_entries` and `journal_lines` with default values (`default_currency_code` and `1.000000`).
  - This guarantees zero schema churn when full multi-currency revaluation and foreign currency cash books are activated in P2.

---

## 3. Fiscal Year & Accounting Periods Strategy

### 3.1. Foundation Fields
`company_settings` (from migration 012) already defines:
- `fiscal_year_start_month` (1..12, default 1)
- `fiscal_year_start_day` (1..28, default 1)

### 3.2. Period Derivation and Lock Model
1. **Fiscal Year Definition**:
   - An annual period spanning 12 months starting from `(fiscal_year_start_month, fiscal_year_start_day)`.
   - E.g., for Egyptian companies starting July 1: FY2026 runs from `2025-07-01` to `2026-06-30`.
2. **Monthly Fiscal Periods (`accounting_periods`)**:
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
       CONSTRAINT uq_company_period UNIQUE (company_id, fiscal_year, period_number)
   );
   ```
3. **Period Lock Invariant**:
   - When posting a journal entry with `entry_date`, the system resolves the matching `accounting_period`.
   - If the resolved period has `is_closed = true`:
     - Posting is **rejected** with `ValidationError: Accounting period for this date is closed`.
     - Reversals must also be posted into an active, open period.

---

## 4. Implementation Phasing
- **P1a (Now)**: Architectural specification and schema definition.
- **P1b (Next)**: Period resolution helper in `accountService` / `journalService` asserting that posting dates fall into an unclosed period.
- **P2**: Year-end close wizard and retained earnings rollup automation.
