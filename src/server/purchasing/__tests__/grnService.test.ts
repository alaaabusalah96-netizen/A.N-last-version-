import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GrnService } from '../grnService.js';
import { ValidationError } from '../../http/errors.js';
import * as transactionManager from '../../db/transactionManager.js';

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn((companyId, callback) => callback({} as any)),
}));

describe('GrnService - Idempotency', () => {
  it('should reject posting an already posted GRN', async () => {
    const mockGrnRepo = {
      findByIdForUpdate: vi.fn().mockResolvedValue({ id: '1', status: 'posted' }),
    } as any;
    const mockSettingsRepo = {
      getByCompanyId: vi.fn().mockResolvedValue({ 
        inventoryAccountId: 'acc1', 
        purchasesClearingAccountId: 'acc2' 
      }),
    } as any;
    const mockJournalService = {
      createDraftEntry: vi.fn(),
      postEntry: vi.fn(),
    } as any;
    
    // We need to inject mocks for dependencies used in postGrn
    const service = new GrnService(
      mockGrnRepo,
      {} as any, // supplierRepo
      {} as any, // warehouseRepo
      {} as any, // itemRepo
      {} as any, // stockRepo
      {} as any, // auditService
      {} as any, // journalRepo
      mockSettingsRepo // settingsRepo
    );
    // Overriding the journal service dependency directly isn't easy as it's imported default
    
    await expect(service.postGrn('comp1', '1', 'user1'))
      .rejects.toThrow(ValidationError);
  });
});
