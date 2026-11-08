# P1 Migration Sequence & Delivery Plan

**Package**: AN-P1A-LEDGER-ORG-DESIGN-1  
**Status**: APPROVED DESIGN PLAN  
**Date**: 2026-11-08  

To prevent catastrophic monolithic migration rollouts, the implementation of P1 is broken down into disciplined, phased, atomic packages.
Rule: Never create one mega-migration mixing org, rbac, and ledger. We mandate separate migrations for AN-P1B-LEDGER-GUARANTEES-1 and AN-P1C-ORG-UNITS-1.

---

## 1. Migration Sequence & Phasing

```
[AN-P1A-LEDGER-ORG-DESIGN-1] (Current: ADRs & Logical Design Only)
          │
          ▼
[AN-P1B-LEDGER-GUARANTEES-1]
   - Migration 013: accounting_sequences, accounting_periods, journal constraints & immutability triggers
   - Backend ledger engine: post, draft, validate balance, sequence number assignment, reversal
   - Automated tests for double-entry invariants
          │
          ▼
[AN-P1C-ORG-UNITS-1]
   - Migration 014: org_units, user_org_scope, nullable org_unit_id on accounting tables
   - Backend OrgUnitService & routes under /api/companies/:companyId/org-units
   - Application-layer org scope authorization gates
          │
          ▼
[AN-P1D-ACCOUNTING-UI-EXPANSION-1]
   - Journal entry creation & posting UI
   - Org unit selector & branch drilldowns in COA and trial balance
```

---

## 2. Detailed Migration Specifications

### Package P1b: Ledger Guarantees & Sequences
- **Target File**: `database/migrations/013_ledger_guarantees.sql`
- **Scope**:
  1. `accounting_sequences` table.
  2. `accounting_periods` table.
  3. `journal_entries` status, posting, and sequence columns.
  4. `journal_lines` check constraints (`chk_line_non_negative_amounts`, `chk_line_has_movement`).
  5. Immutability trigger preventing `UPDATE` or `DELETE` on posted entries and lines.
  6. RLS policies and table ownership registration for `accounting_sequences` and `accounting_periods`.
- **Precheck**:
  - Verify migration 011 is applied and `journal_entries` table exists.
  - Verify existing rows in `journal_entries` are in balance.
- **Postcheck**:
  - Attempting to update a posted entry fails closed with exception.
  - Attempting to post an unbalanced entry fails closed with exception.
- **Rollback Note**:
  - Dropping trigger functions, check constraints, and helper tables.

---

### Package P1c: Organizational Structure
- **Target File**: `database/migrations/014_org_structure.sql`
- **Scope**:
  1. `org_units` table with adjacency list (`parent_id`) and `path`.
  2. `user_org_scope` table.
  3. Foreign keys from `accounts.org_unit_id`, `journal_entries.org_unit_id`, and `journal_lines.org_unit_id`.
  4. RLS policies and table ownership registration.
- **Precheck**:
  - Verify company table exists.
- **Postcheck**:
  - Foreign key integrity from org units to company.
  - Circular parent relationship prevention check.
- **Rollback Note**:
  - Remove foreign keys and drop `user_org_scope` and `org_units`.

---

## 3. Template for Individual Migration Execution

Every future migration package must document and execute the following 4-step protocol:

```markdown
### 1. Pre-Execution Validation
- Confirm previous migrations 001..N are applied.
- Confirm zero active uncommitted transactions.
- Check database role executing migration (`an_app` for DML, migration runner for DDL).

### 2. Idempotent Migration Execution
- Wrap DDL in a transaction (`BEGIN ... COMMIT`).
- Use `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`.
- Apply explicit grants to `an_app`.

### 3. Verification Assertion
- Run automated schema verification script (e.g. `verifyMigration013.ts`).
- Verify RLS coverage via `scripts/verifyRlsCoverage.ts`.

### 4. Rollback Plan
- Document exact SQL statements to reverse changes in reverse topological order.
```
