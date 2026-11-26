import { describe, it, expect, vi } from 'vitest';
import { CompanySettingsService } from '../companySettingsService.js';
import { ValidationError } from '../../http/errors.js';

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn((_c: string, cb: (tx: unknown) => Promise<unknown>) => cb({})),
}));
vi.mock('../../audit/auditService.js', () => ({ defaultAuditService: { record: vi.fn() } }));
const accounts: Record<string, any> = {
  vatOut: { id: 'vatOut', code: '2310', isActive: true, isPostable: true, accountType: 'liability' },
  vatIn: { id: 'vatIn', code: '1310', isActive: true, isPostable: true, accountType: 'asset' },
  vatHdr: { id: 'vatHdr', code: '2300', isActive: true, isPostable: false, accountType: 'liability' },
  rev: { id: 'rev', code: '4100', isActive: true, isPostable: true, accountType: 'revenue' },
};
vi.mock('../../accounting/accountRepository.js', () => ({
  defaultAccountRepository: { findById: vi.fn(async (_c: string, id: string) => accounts[id] ?? null) },
}));

const C = '11111111-1111-4111-8111-111111111111';
const mk = (existing: any = null) => {
  const upsert = vi.fn().mockResolvedValue({});
  const getByCompanyId = vi.fn().mockResolvedValue(existing);
  return { svc: new CompanySettingsService({ upsert, getByCompanyId } as any), upsert };
};

describe('company VAT settings', () => {
  it('defaults: VAT off, rate 0, exclusive prices, input recoverable, line rounding', async () => {
    const { svc } = mk(null);
    const s = await svc.getSettings(C);
    expect(s.vatEnabled).toBe(false);
    expect(s.defaultVatRate).toBe(0);
    expect(s.pricesIncludeVat).toBe(false);
    expect(s.vatInputRecoverable).toBe(true);
    expect(s.vatRoundingMode).toBe('line');
    expect(s.vatPayableAccountId).toBeNull();
  });
  it('rejects out-of-range, non-numeric or 3-decimal rates', async () => {
    const { svc } = mk();
    for (const r of [-1, 100.01, Number.NaN, 14.123, '14' as any]) {
      await expect(svc.upsertSettings('u', C, { defaultVatRate: r })).rejects.toBeInstanceOf(ValidationError);
    }
  });
  it('accepts 0, 14 and 14.5 and 100', async () => {
    for (const r of [0, 14, 14.5, 100]) {
      const { svc, upsert } = mk();
      await svc.upsertSettings('u', C, { defaultVatRate: r });
      expect(upsert).toHaveBeenCalled();
    }
  });
  it('rejects unknown rounding mode and non-boolean flags', async () => {
    const { svc } = mk();
    await expect(svc.upsertSettings('u', C, { vatRoundingMode: 'x' as any })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.upsertSettings('u', C, { vatEnabled: 'yes' as any })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.upsertSettings('u', C, { pricesIncludeVat: 1 as any })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.upsertSettings('u', C, { vatInputRecoverable: 'no' as any })).rejects.toBeInstanceOf(ValidationError);
  });
  it('validates VAT accounts: type, postable, distinct', async () => {
    const { svc } = mk();
    await expect(svc.upsertSettings('u', C, { vatPayableAccountId: 'vatHdr' })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.upsertSettings('u', C, { vatPayableAccountId: 'rev' })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.upsertSettings('u', C, { vatPayableAccountId: 'vatIn' })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.upsertSettings('u', C, { vatInputAccountId: 'vatOut' })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.upsertSettings('u', C, { vatPayableAccountId: 'nope' })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.upsertSettings('u', C, { vatPayableAccountId: 'vatOut', vatInputAccountId: 'vatOut' })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.upsertSettings('u', C, { vatPayableAccountId: 'vatOut', vatInputAccountId: 'vatIn' })).resolves.toBeDefined();
  });
  it('cannot enable VAT without an output VAT account', async () => {
    await expect(mk(null).svc.upsertSettings('u', C, { vatEnabled: true })).rejects.toBeInstanceOf(ValidationError);
    await expect(mk({ vatPayableAccountId: null }).svc.upsertSettings('u', C, { vatEnabled: true })).rejects.toBeInstanceOf(ValidationError);
    await expect(mk({ vatPayableAccountId: 'vatOut' }).svc.upsertSettings('u', C, { vatEnabled: true })).resolves.toBeDefined();
    await expect(mk(null).svc.upsertSettings('u', C, { vatEnabled: true, vatPayableAccountId: 'vatOut' })).resolves.toBeDefined();
  });
  it('disabling VAT needs no account', async () => {
    await expect(mk(null).svc.upsertSettings('u', C, { vatEnabled: false })).resolves.toBeDefined();
  });
});
