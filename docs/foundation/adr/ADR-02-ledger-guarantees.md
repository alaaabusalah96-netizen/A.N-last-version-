# ADR-02: Double-Entry Ledger Guarantees & Integrity Invariants

- **Status**: APPROVED (Design Phase)
- **Context**: P1 Architecture Foundations (AN-P1A-LEDGER-ORG-DESIGN-1)
- **Date**: 2026-11-08
- **Author**: Platform Architecture Team

---

## 1. Context and Problem Statement
The Core Accounting module (`migration 011_accounting_core.sql`) introduced `journal_entries` and `journal_lines`. To transition from simple record keeping to an audit-grade financial ledger, the system must guarantee strict double-entry balance, tenant isolation across parent entries and child lines, immutability of posted records, and monotonic sequence numbering without gaps.

---

## 2. Decision Drivers
1. **Mathematical Balance**: For every posted journal entry: $\sum \text{debit} = \sum \text{credit}$ down to the minor currency unit.
2. **Tenant Line Consistency**: A journal line cannot belong to Company B if the journal entry belongs to Company A, nor can an account belonging to Company B be referenced.
3. **Immutability of Posted Entries**: Once an entry is marked `posted`, neither the entry nor its lines can ever be updated or deleted. Corrections must strictly occur via counter-entries (reversals).
4. **Concurrency & Atomicity**: Postings must occur in atomic transactions with optimistic/pessimistic row locking on sequence counters.

---

## 3. Core Architectural Decisions for P1b

### 3.1. Balanced Entry Enforcement
- In draft state (`status = 'draft'`), entries can temporarily be out of balance while lines are entered.
- When an entry transitions to `posted`:
  1. A validation trigger or transaction-level deferred constraint verifies:
     ```sql
     SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
     FROM journal_lines
     WHERE journal_entry_id = NEW.id;
     -- Must satisfy SUM(debit) == SUM(credit) AND SUM(debit) > 0
     ```
  2. The entry must contain at least two non-zero lines.
  3. All amounts must be positive ($\text{debit} \ge 0, \text{credit} \ge 0$) and exactly one of (debit > 0 or credit > 0) per line.

### 3.2. Cross-Table Tenant Consistency Invariant
To prevent any line from pointing to an account outside the entry's company:
- Composite foreign key pattern:
  `journal_lines (company_id, account_id) REFERENCES accounts (company_id, id)`.
- Composite entry reference:
  `journal_lines (company_id, journal_entry_id) REFERENCES journal_entries (company_id, id)`.
- This enforces at the database foreign key level that lines, parent entries, and accounts share the identical `company_id`.

### 3.3. Draft vs Posted State Machine & Immutability
States:
1. `draft`: Editable, lines can be added, updated, or deleted. Not included in official balance sheet or trial balance reporting.
2. `posted`: Permanent, audited, and immutable.
   - Enforced by database trigger: `BEFORE UPDATE OR DELETE ON journal_entries / journal_lines` fails if `OLD.status = 'posted'`.
   - Reversal: Only achievable via `POST /api/accounting/journal-entries/:id/reverse`, which creates a new balanced entry referencing `reversed_entry_id` with negated/swapped debits and credits.
3. `voided`: Allowed only for `draft` entries.

### 3.4. Numbering Sequences Per Company
- Monotonically increasing human-readable entry numbers per company per fiscal year (e.g. `JE-2026-000001`).
- Implemented via a dedicated `accounting_sequences` table locked with `SELECT ... FOR UPDATE` inside the posting transaction:
  ```sql
  CREATE TABLE accounting_sequences (
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      series_key VARCHAR(50) NOT NULL, -- e.g. 'JE-2026'
      current_value BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (company_id, series_key)
  );
  ```

---

## 4. Scope Breakdown: P1b vs Deferred

### Included in P1b:
- Balance check at posting time (`SUM(debit) = SUM(credit)`).
- Minimum two lines validation.
- Zero/negative amount prevention (`debit >= 0 AND credit >= 0`).
- Tenant foreign key consistency (`company_id` integrity).
- Draft vs Posted transition state machine.
- Immutability trigger on posted entries and lines.
- Atomic posting sequence numbering per company.
- Reverse entry transaction helper.

### Deferred to P1b+ / P2:
- Multi-period automatic closing entries.
- Automated recurring journal schedules.
- Multi-currency revaluation entries.
- Real-time dimensional allocation matrix.
