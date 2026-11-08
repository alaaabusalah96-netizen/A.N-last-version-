# ADR-01: Organizational Structure (Org Units & Hierarchy)

- **Status**: APPROVED (Design Phase)
- **Context**: P1 Architecture Foundations (AN-P1A-LEDGER-ORG-DESIGN-1)
- **Date**: 2026-11-08
- **Author**: Platform Architecture Team

---

## 1. Context and Problem Statement
A.N ERP Platform currently scopes operations at the `company` level (legal entity / tenant). Real-world operational enterprises require sub-company structures for operational reporting, cost allocation, and delegation of duties across branches, regional offices, departments, and cost centers. We need a standardized organizational model that integrates smoothly with the existing multi-tenant architecture without disrupting database-level Row-Level Security (RLS) or introducing cross-tenant leakage.

---

## 2. Decision Drivers
1. **Tenant Integrity**: The legal entity `company_id` is the immutable primary tenant boundary for RLS (`app.current_tenant_id`). Org units must live strictly inside a company.
2. **Hierarchy Modeling**: Need to represent hierarchical parent-child relationships (e.g. Headquarters -> Northern Region -> Alexandria Branch -> Retail Operations).
3. **Performance & Simplicity**: Hierarchical queries for roll-up reporting must be efficient in PostgreSQL.
4. **Gradual Rollout**: Initial accounting entries must work whether or not an organization has defined branches or cost centers.
5. **No Intercompany in P1**: Cross-company transactions (intercompany eliminations, transfers across distinct legal entities) are strictly out of scope for P1.

---

## 3. Considered Options
- **Option A**: Recursive `parent_id` foreign key only. Simple schema, but tree roll-ups require recursive CTEs (`WITH RECURSIVE`).
- **Option B**: PostgreSQL `ltree` extension. Extremely fast path indexing (`top.branch1.dept2`), but requires installing PostgreSQL extension (`CREATE EXTENSION ltree`) which may complicate unprivileged app role migrations or restricted cloud DB tiers.
- **Option C**: Adjacency list (`parent_id`) supplemented with a materialized path or closure table in later optimizations.

---

## 4. Decision: Adjacency List (`parent_id`) with Path String
We select **Adjacency List with a denormalized path string** (`parent_id UUID NULL REFERENCES org_units(id)` and `path TEXT NOT NULL DEFAULT '/'`):
- Pure standard SQL without external extension requirements (works identically on Supabase, Amazon RDS, vanilla PostgreSQL, or CI).
- Easy updates: moving a node only updates immediate parent and recalculates prefix paths.

### Structure:
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_company_org_unit_code UNIQUE (company_id, code)
);
```

### Unit Types (Minimal v1 Enum):
1. `branch` (فرع تشغيلي/جغرافي): Independent operating unit with physical location.
2. `department` (قسم إداري/تشغيلي): Functional division (e.g., HR, Sales, IT).
3. `cost_center` (مركز تكلفة): Accounting allocation sink.
4. `division` (قطاع أعمال): High-level business grouping.

### User Org Scoping (`user_org_scope`):
Users are granted access via:
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
```
- When `include_descendants = true`, granting access to a branch automatically grants access to all departments and cost centers under that branch's path.

### Org Unit Nullability on Financial Tables in P1:
- `journal_entries.org_unit_id`: **Nullable** in P1. If NULL, the transaction applies to the company as a whole (corporate/unallocated).
- `journal_lines.org_unit_id`: **Nullable** in P1. Allows line-level cost center or branch assignment.
- `accounts.org_unit_id`: **Nullable** in P1. Balance sheet accounts are typically company-level; revenue/expense accounts may optionally be tied to specific org units.

---

## 5. Consequences & Boundaries
- **Positive**: Clean encapsulation of operational hierarchy without altering the RLS security boundary.
- **Boundary**: Strict prohibition on multi-company org nodes: every `org_unit` belongs to exactly one `company_id`.
- **Deferred to P2**: Automated intercompany recharges and consolidated group hierarchies.
