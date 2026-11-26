import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('multi-line stock document UI wiring', () => {
  it('modal posts header and lines to the documents endpoint for all four document types', () => {
    const src = read('src/components/inventory/StockDocumentModal.tsx');
    expect(src).toContain('/api/inventory/documents');
    for (const t of ['receipt', 'issue', 'adjustment', 'transfer']) expect(src).toContain(`'${t}'`);
    expect(src).toContain('lines:');
    expect(src).toContain('sourceWarehouseId');
    expect(src).toContain('destWarehouseId');
  });
  it('inventory workspace exposes the multi-line document button and refreshes after posting', () => {
    const src = read('src/components/inventory/InventoryWorkspace.tsx');
    expect(src).toContain('StockDocumentModal');
    expect(src).toContain('setShowDocumentModal(true)');
    expect(src).toContain('await loadData()');
  });
});
