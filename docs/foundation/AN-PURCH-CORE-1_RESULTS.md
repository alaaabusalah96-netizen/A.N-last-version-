# AN-PURCH-CORE-1 Results Document

## Package Identification
- **Package**: `AN-PURCH-CORE-1`
- **Type**: Lean / First Purchasing Slice — Supplier + GRN → Inventory
- **Repository**: `alaaabusalah96-netizen/A.N-last-version-`
- **Branch**: `main`

## Summary of Changes
1. **Migration 021 (`021_purchasing_core.sql`)**:
   - Created `purch_suppliers`, `purch_grn`, and `purch_grn_lines` tables with forced RLS and tenant isolation policies for `an_app`.
   - Registered all 3 tables in `database/table_ownership.json`.

2. **Permissions & RBAC (`permissions.ts`, `roles.ts`)**:
   - Registered `purchasing:read`, `purchasing:write`, `purchasing:post`.
   - Assigned permissions across `platform_admin`, `company_admin`, and `company_user` roles.

3. **Backend Engine & Services (`src/server/purchasing/`)**:
   - `purchasingTypes.ts`: Data interfaces for Supplier, GRN, and GRN lines.
   - `supplierRepository.ts` / `supplierService.ts`: Supplier master CRUD.
   - `grnRepository.ts` / `grnService.ts`: Draft GRN creation and `postGrn` confirming GRN status and executing atomic stock receive updates across inventory stock balances and movement ledgers.

4. **HTTP API Routes (`purchasingRoutes.ts` & `app.ts`)**:
   - Mounted `purchasingRoutes` at `/api/purchasing`.
   - Endpoints: `GET/POST /api/purchasing/suppliers`, `GET/POST /api/purchasing/grn`, `POST /api/purchasing/grn/:id/post`.

5. **UI Workspace (`PurchasingWorkspace.tsx`, `AppSidebar.tsx`, `App.tsx`)**:
   - Created `PurchasingWorkspace.tsx` with Suppliers tab and Goods Receipt Notes (GRN) tab.
   - Added Modals for creating suppliers and creating draft GRNs with dynamic item line inputs.
   - Added Post action button to confirm GRNs and post stock to inventory.
   - Added "المشتريات" link to `AppSidebar.tsx` and routed in `App.tsx`.

6. **Static Verification Harness (`scripts/verifyPurchCore1.ts`)**:
   - Configured test script `npm run test:purch-core-1` covering assertions S1–S7.
   - Registered `verifyPurchCore1.ts` in `scripts/lib/battery_exclusions.json`.

## Verification Results
- **TypeScript Typecheck**: `npm run typecheck` — **PASSED**
- **Purchasing Core Verification**: `npm run test:purch-core-1` — **PASSED (7/7)**
- **Battery Integrity**: `npm run test:battery-integrity` — **PASSED**
- **Production Build**: `npm run build` — **PASSED**
- **Applet Compilation & Linting**: `compile_applet` & `lint_applet` — **PASSED**
