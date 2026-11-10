# AN-INV-CORE-1 Results Report

## 1. Overview
- **Package**: `AN-INV-CORE-1`
- **Type**: Lean / First Operational Module — Inventory Core
- **Repository**: `alaaabusalah96-netizen/A.N-last-version-`
- **Branch**: `main`
- **Baseline**: After `AN-PG-SMOKE-LIVE-CI-1`

## 2. Delivered Features & Components
1. **Migration 019 (`019_inventory_core.sql`)**:
   - `inv_warehouses`: Company-scoped warehouses master with `UNIQUE(company_id, code)`.
   - `inv_items`: Company-scoped products master with `UNIQUE(company_id, code)` and `uom`.
   - `inv_stock_balances`: Primary key composite `(company_id, warehouse_id, item_id)` with `CHECK (qty >= 0)`.
   - `inv_stock_movements`: Movement ledger tracking `receive` and `issue` operations with `CHECK (qty > 0)`.
   - Enabled and forced Row Level Security (RLS) on all 4 tables with tenant isolation policies for role `an_app`. Registered in `database/table_ownership.json`.

2. **Modular Backend Services**:
   - `warehouseRepository.ts` & `warehouseService.ts`: List and create warehouses with code uniqueness check.
   - `itemRepository.ts` & `itemService.ts`: List and create items with code uniqueness check.
   - `stockRepository.ts` & `stockService.ts`:
     - `receiveStock`: Increases item balance and logs movement atomically inside a tenant transaction (`withTenantTransaction`).
     - `issueStock`: Decreases item balance with row-level locking (`FOR UPDATE`) and enforces a strict **non-negative stock guard** (`currentQty < input.qty` throws `ValidationError`).

3. **HTTP API (`inventoryRoutes.ts`)**:
   - Mounted at `/api/inventory` in `src/server/app.ts`.
   - Endpoints: `GET/POST /warehouses`, `GET/POST /items`, `GET /balances`, `GET /movements`, `POST /receive`, `POST /issue`.
   - Secured with `requireAuth`, domain permission checks (`inventory:read`, `inventory:write`, `inventory:movement`), and active tenant membership scoping.

4. **UI Workspace & Navigation**:
   - `InventoryWorkspace.tsx`: Multi-tab workspace for Balances, Warehouses, Items, and Movements + Receive/Issue dialogs.
   - Integrated into `AppSidebar.tsx` ("المخزون") and routed in `App.tsx`.
