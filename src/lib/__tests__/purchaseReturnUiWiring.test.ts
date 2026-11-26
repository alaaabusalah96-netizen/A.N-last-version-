import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(process.cwd(), 'src/components/purchasing/PurchasingWorkspace.tsx'), 'utf8');

describe('purchase return UI wiring', () => {
  it('lets the user pick the goods receipt and sets grnId and warehouseId from it', () => {
    expect(src).toContain('const selectReturnGrn = (grnId: string)');
    expect(src).toContain('setReturnGrnId(grnId)');
    expect(src).toContain("setReturnWarehouseId(lines[0]?.warehouseId || '')");
    expect(src).toContain('data-testid="return-grn-select"');
  });
  it('shows save errors inside the modal instead of behind it', () => {
    expect(src).toContain('data-testid="return-modal-error"');
  });
  it('blocks save until a goods receipt is chosen', () => {
    expect(src).toContain('!returnGrnId || !returnWarehouseId');
  });
});
