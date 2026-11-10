# AN-INV-TRANSFER-1 Results Document

## Package Identification
- **Package**: `AN-INV-TRANSFER-1`
- **Type**: Lean Inventory Extension — Same-Company Warehouse Transfer
- **Repository**: `alaaabusalah96-netizen/A.N-last-version-`
- **Branch**: `main`

## Summary of Changes
1. **Migration 020 (`020_inventory_transfer.sql`)**:
   - Extended `inv_stock_movements.movement_type` constraint to include `'transfer_out'`, `'transfer_in'`, `'transfer'`.
   - Added `transfer_id UUID NULL` column to link movement pairs.
   - Created index `idx_inv_stock_movements_transfer` on `(company_id, transfer_id)`.

2. **Backend Engine & Service (`stockService.ts`, `stockRepository.ts`)**:
   - Implemented `stockService.transfer(companyId, input, actorId)` inside single tenant transaction (`withTenantTransaction`).
   - Implemented deterministic deadlock-safe lock ordering by sorting warehouse IDs before acquiring `FOR UPDATE` balance locks.
   - Validated source and destination warehouses belong to `companyId` and are active (blocking cross-company transfers).
   - Validated `sourceWarehouseId !== destWarehouseId` (blocking same-warehouse transfers).
   - Enforced strict non-negative stock guard on source warehouse.
   - Updated source & destination balances atomically and generated paired `transfer_out` / `transfer_in` stock movement rows sharing `transferId`.

3. **HTTP API Route (`inventoryRoutes.ts`)**:
   - Exposed `POST /api/inventory/transfers` guarded by `INVENTORY_MOVEMENT` permission.

4. **UI Workspace (`InventoryWorkspace.tsx`)**:
   - Added Transfer action button ("إذن تحويل").
   - Added "التحويلات بين المستودعات" tab displaying transfer movements.
   - Added Transfer Modal dialog for warehouse-to-warehouse stock transfers.

5. **Static Verification Harness (`scripts/verifyInvTransfer1.ts`)**:
   - Configured test script `npm run test:inv-transfer-1` covering assertions S1–S6.
   - Registered `verifyInvTransfer1.ts` in `scripts/lib/battery_exclusions.json`.

## Verification Results
- **TypeScript Typecheck**: `npm run typecheck` — **PASSED**
- **Inventory Transfer Suite**: `npm run test:inv-transfer-1` — **PASSED (6/6)**
- **Battery Integrity**: `npm run test:battery-integrity` — **PASSED**
- **Production Build**: `npm run build` — **PASSED**
- **Applet Compilation & Linting**: `compile_applet` & `lint_applet` — **PASSED**
