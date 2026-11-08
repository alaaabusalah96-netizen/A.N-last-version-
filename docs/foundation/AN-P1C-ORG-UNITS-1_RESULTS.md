# AN-P1C-ORG-UNITS-1 Results Report

**Package**: AN-P1C-ORG-UNITS-1  
**Type**: LEAN / ORG UNITS IMPLEMENTATION  
**Status**: IMPLEMENTED  
**Date**: 2026-11-08  

---

## 1. Executive Summary

This package implemented company-scoped organizational units and user org scoping according to ADR-01 and ADR-03:
1. **Migration 014 (`database/migrations/014_org_units.sql`)**:
   - `org_units`: Adjacency list (`parent_id`) with denormalized hierarchical path string (`path`).
   - `user_org_scope`: Authorizes specific users to operate inside designated units with optional descendant inclusion (`include_descendants`).
   - Extended `accounts`, `journal_entries`, and `journal_lines` with nullable `org_unit_id` foreign keys.
   - Row-Level Security: Enabled and forced tenant RLS for `an_app` tied to `company_id`. Registered in `table_ownership.json`.
2. **Backend Engine (`src/server/org/orgUnitService.ts`)**:
   - Automated hierarchical path calculation on node creation.
   - Strict validation preventing intercompany parenting (`parent.companyId === companyId`).
   - Application-layer scoping helper (`assertUserOrgAccess`) for backward-compatible visibility filtering.
3. **API Endpoints (`src/server/routes/orgUnitRoutes.ts`)**:
   - Nested under `/api/companies/:companyId/org-units` (list, create, patch) and `/api/companies/:companyId/org-scopes`.
   - Guarded by `ORG_UNITS_READ` and `ORG_UNITS_WRITE` permissions.
4. **User Interface (`src/components/org/OrgUnitsPanel.tsx`)**:
   - Added «الوحدات التنظيمية» to `AppSidebar` and wired into `App.tsx`.
   - Company selector, tree-indented hierarchical display, and unit creation modal with parent selection.

---

## 2. Verification & Automated Tests

- `npm run typecheck`: 0 errors
- `npm run build`: PASS
- `npm run test:p1c-org-units-1`: 9 of 9 checks passed (100%)
- `npm run test:p1b-ledger-1`: 10 of 10 checks passed (100% regression check)
- `npm run test:unit`: 6 test files, 30 tests passed

---

## 3. Strict Boundary Compliance

- **No Intercompany**: Org units belong strictly to their parent `company_id`.
- **No RLS v2**: Database RLS remains strictly company-level via `withTenantTransaction`; org units operate at the application layer.
- **Operator Action Required**: On deployed environments, operator must run `npm run migrate` to apply `014_org_units.sql`.
