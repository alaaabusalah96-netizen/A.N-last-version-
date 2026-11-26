import { describe, it, expect, vi } from 'vitest';
import { CompanySettingsService } from '../companySettingsService.js';
import { ValidationError } from '../../http/errors.js';

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn((_c: string, cb: (tx: unknown) => Promise<unknown>) => cb({})),
}));
vi.mock('../../audit/auditService.js', () => ({ defaultAuditService: { record: vi.fn() } }));
const accounts: Record<string, any> = {
  hdr: { id: 'hdr', code: '1300', isActive: true, isPostable: false, accountType: 'asset' },
  inv: { id: 'inv', code: '1400', isActive: true, isPostable: true, accountType: 'asset' },
  rev: { id: 'rev', code: '4100', isActive: true, isPostable: true, accountType: 'revenue' },
  ap: { id: 'ap', code: '2100', isActive: true, isPostable: true, accountType: 'liability' },
  apHdr: { id: 'apHdr', code: '2200', isActive: true, isPostable: false, accountType: 'liability' },
};
vi.mock('../../accounting/accountRepository.js', () => ({
  defaultAccountRepository: { findById: vi.fn(async (_c: string, id: string) => accounts[id] ?? null) },
}));

const C = '11111111-1111-4111-8111-111111111111';
const svc = () => new CompanySettingsService({ upsert: vi.fn().mockResolvedValue({}) } as any);

describe('company settings GL account validation', () => {
  it('rejects header (non-postable) accounts 1300 / 2200', async () => {
    await expect(svc().upsertSettings('u', C, { inventoryAccountId: 'hdr' })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc().upsertSettings('u', C, { accountsPayableAccountId: 'apHdr' })).rejects.toBeInstanceOf(ValidationError);
  });
  it('rejects wrong account type', async () => {
    await expect(svc().upsertSettings('u', C, { inventoryAccountId: 'rev' })).rejects.toBeInstanceOf(ValidationError);
  });
  it('accepts valid postable accounts of the right type', async () => {
    await expect(svc().upsertSettings('u', C, { inventoryAccountId: 'inv', accountsPayableAccountId: 'ap' })).resolves.toBeDefined();
  });
});

