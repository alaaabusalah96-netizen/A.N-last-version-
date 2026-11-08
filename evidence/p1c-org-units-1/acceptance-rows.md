# Acceptance Rows — AN-P1C-ORG-UNITS-1

| Check ID | Requirement | Verification Method | Result | Notes |
|----------|-------------|---------------------|--------|-------|
| S1 | Migration 014 (org_units & user_org_scope) | Inspection of `database/migrations/014_org_units.sql` | PASS | Defines `org_units`, `user_org_scope`, and alters accounting tables with nullable `org_unit_id` |
| S2 | Table Ownership Registration | Inspection of `database/table_ownership.json` | PASS | `org_units` and `user_org_scope` registered under `tenant` scope |
| S3 | Org Units Routes Mounted & Gated | Inspection of `src/server/routes/orgUnitRoutes.ts` & `companyRoutes.ts` | PASS | Mounted under `/:companyId/org-units` and gated by `ORG_UNITS_READ/WRITE` |
| S4 | Parent Same-Company & Path Computation | Inspection of `src/server/org/orgUnitService.ts` | PASS | Validates `parent.companyId === companyId` (no intercompany) and generates hierarchical path |
| S5 | UI Wiring & Arabic Label | Inspection of `AppSidebar.tsx` and `App.tsx` | PASS | Added «الوحدات التنظيمية» to sidebar navigation and wired `OrgUnitsPanel` |
| S6 | RBAC Permissions Mapped | Inspection of `permissions.ts` and `roles.ts` | PASS | `ORG_UNITS_READ` and `ORG_UNITS_WRITE` mapped to roles |
| S7 | P1b Ledger Guarantees Intact | Inspection of `src/server/accounting/journalService.ts` | PASS | `postEntry` and sequence allocation unaltered |
| S8 | AI Project State Status | Inspection of `docs/foundation/AI_PROJECT_STATE.md` | PASS | Documented as `AN-P1C-ORG-UNITS-1: IMPLEMENTED` |
| S9 | Tenant Isolation Kernel | Inspection of `orgUnitRepository.ts` & `orgUnitService.ts` | PASS | All operations wrapped in `withTenantTransaction(companyId, ...)` |
| Typecheck | Clean TypeScript Compilation | `npm run typecheck` | PASS | 0 errors |
| Build | Client & Server Production Bundle | `npm run build` | PASS | Clean Vite & esbuild bundles |
| Verification | Automated Harness | `npm run test:p1c-org-units-1` | PASS | 9 of 9 checks pass |
