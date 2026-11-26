import { describe, it, expect, vi } from 'vitest';
import { ItemService } from '../itemService.js';
import { WarehouseService } from '../warehouseService.js';

const COMP = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

describe('Warehouse / item master data update', () => {
  it('updates item name and active flag with audit', async () => {
    const itemRepo = {
      findById: vi.fn().mockResolvedValue({ id: ID, code: 'I-1', nameAr: 'قديم', isActive: true }),
      update: vi.fn().mockResolvedValue({ id: ID, code: 'I-1', nameAr: 'جديد', isActive: false }),
    } as any;
    const audit = { record: vi.fn() } as any;
    const svc = new ItemService(itemRepo, audit, {} as any);
    const res = await svc.updateItem(COMP, ID, { nameAr: 'جديد', isActive: false }, 'actor');
    expect(res.nameAr).toBe('جديد');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'ITEM_UPDATE' }));
  });

  it('rejects empty Arabic name and unknown item', async () => {
    const itemRepo = { findById: vi.fn().mockResolvedValue(null), update: vi.fn() } as any;
    const svc = new ItemService(itemRepo, { record: vi.fn() } as any, {} as any);
    await expect(svc.updateItem(COMP, ID, { nameAr: ' ' })).rejects.toThrow(/لا يمكن أن يكون فارغاً/);
    await expect(svc.updateItem(COMP, ID, { nameAr: 'x' })).rejects.toThrow(/غير موجود/);
  });

  it('rejects update of an unknown warehouse', async () => {
    const repo = { findById: vi.fn().mockResolvedValue(null), update: vi.fn() } as any;
    const svc = new WarehouseService(repo, { record: vi.fn() } as any);
    await expect(svc.updateWarehouse(COMP, ID, { nameAr: 'مخزن' })).rejects.toThrow(/غير موجود/);
  });
});
