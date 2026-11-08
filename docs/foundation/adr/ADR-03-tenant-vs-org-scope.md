# ADR-03: Tenant Boundary vs. Organizational Unit Scope

- **Status**: APPROVED (Design Phase)
- **Context**: P1 Architecture Foundations (AN-P1A-LEDGER-ORG-DESIGN-1)
- **Date**: 2026-11-08
- **Author**: Platform Architecture Team

---

## 1. Context and Problem Statement
A fundamental security requirement of the A.N ERP Platform is strict multi-tenant isolation. With the introduction of sub-company organizational units (branches, cost centers, departments), there is a critical need to clarify how tenant-level security (Row-Level Security via `company_id`) interacts with organizational data scoping.

---

## 2. Core Architectural Principles

### 2.1. Company as the Primary Security Kernel
- **Tenant Scope = Security Boundary**: The database-enforced RLS kernel (`app.current_tenant_id`) is strictly bound to `company_id`.
- Every tenant table has `relforcerowsecurity = true` and checks `company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid`.
- `withTenantTransaction(companyId, ...)` remains the mandatory, non-bypassable database execution envelope for all tenant reads and writes.

### 2.2. Org Unit as Application-Layer Filtering (Phase 1)
- **Org Scope = Functional / Authorization Filter**: Org units exist to segment data within a company for operational convenience and department-level access control.
- In Phase 1 (P1c), Org scoping is enforced in the **application layer** via `user_org_scope` checks inside domain services and repository query builders:
  ```sql
  WHERE company_id = $1 AND (org_unit_id IN (/* authorized org units */) OR org_unit_id IS NULL)
  ```
- **Why not database RLS for Org Units in P1?**
  1. Performance: Complex hierarchical tree queries inside PostgreSQL RLS policy functions on every row access introduce significant execution overhead.
  2. Flexibility: Financial consolidation often requires corporate accountants to see all branch numbers, while branch cashiers only see local branch vouchers.
  3. Safe Migration: Preserves the rock-solid foundation of tenant RLS that has already passed security verification.

### 2.3. Future RLS v2 Compatibility
- In P2, if defense-in-depth DB RLS for org units is desired, session variables can be extended:
  `SELECT set_config('app.current_org_unit_id', $1, true)`.
- The data model in P1 is specifically designed with `company_id` on all tables to ensure full forward-compatibility with any future RLS enhancements.

---

## 3. Integration with `requirePermission` and RBAC

The existing RBAC system evaluates:
```typescript
hasPermission(actor: User, permission: string, companyId?: string): Promise<boolean>
```

In P1, org unit authorization layers on top of RBAC:
1. **Gate 1 (Company & Permission Gate)**:
   - Does the actor have active membership in `companyId`?
   - Does the actor's role have the required permission (e.g. `ACCOUNTING_JOURNAL_CREATE`)?
   - If NO -> `403 Forbidden`.
2. **Gate 2 (Org Unit Scope Gate)**:
   - If the actor is `company_admin`, they have implicit access to all org units in the company.
   - For other roles (`company_user`), query `user_org_scope` for the user and target `org_unit_id`:
     - If user has matching `org_unit_id` OR an ancestor org unit with `include_descendants = true` -> ALLOW.
     - Else -> `403 Forbidden` ("Insufficient organizational unit access").

---

## 4. Summary Table

| Layer | Responsibility | Mechanism | Failure Action |
|-------|----------------|-----------|----------------|
| **Tenant Isolation** | Strict isolation between legal entities | PostgreSQL RLS + `app.current_tenant_id` | DB returns 0 rows (Fail closed) |
| **RBAC** | Capability checking (Read vs Write) | `hasPermission(actor, perm, companyId)` | HTTP 403 Forbidden |
| **Org Scope** | Operational domain visibility | Application service check + `user_org_scope` | HTTP 403 / Filtered result set |
