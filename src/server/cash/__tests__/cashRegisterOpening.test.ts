import { describe, it, expect, vi } from 'vitest';
import { CashRegisterService } from '../cashRegisterService.js';
import { ValidationError } from '../../http/errors.js';

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn((_c: string, cb: (tx: unknown) => Promise<unknown>) => cb({})),
}));
const findById = vi.fn();
const findByCode = vi.fn();
vi.mock('../../accounting/accountRepository.js', () => ({
  defaultAccountRepository: { findById: (...a: unknown[]) => findById(...a), findByCode: (...a: unknown[]) => findByCode(...a) },
}));
vi.mock('../../lib/calendarDate.js', () => ({ resolveCompanyToday: vi.fn(async () => '2026-11-26') }));
vi.mock('../../org/companySettingsRepository.js', () => ({ defaultCompanySettingsRepository: { getByCompanyId: vi.fn(async () => null) } }));

const C = '11111111-1111-4111-8111-111111111111';
const CASH = '77777777-7777-4777-8777-777777777777';
const CAP = '88888888-8888-4888-8888-888888888888';
const cashAcc = { id: CASH, isActive: true, isPostable: true, accountType: 'asset' };
const capAcc = { id: CAP, isActive: true, isPostable: true, accountType: 'equity' };

function make(opening: number) {
  const repo: any = {
    findByCode: vi.fn().mockResolvedValue(null),
    findByGlAccount: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'r1', code: 'C1', nameAr: 'x', glAccountId: CASH, openingBalance: opening }),
    setOpeningEntryId: vi.fn().mockResolvedValue(undefined),
    getOpeningEntryId: vi.fn().mockResolvedValue(null),
    lockForUpdate: vi.fn().mockResolvedValue({ id: 'r1', code: 'C1', glAccountId: CASH, openingBalance: opening }),
  };
  const journal: any = {
    createDraftEntry: vi.fn().mockResolvedValue({ id: 'd1' }),
    postEntry: vi.fn().mockResolvedValue({ id: 'je1' }),
  };
  const audit: any = { record: vi.fn() };
  return { repo, journal, svc: new CashRegisterService(repo, audit, journal) };
}
const input = { code: 'C1', nameAr: 'x', glAccountId: CASH, openingBalance: 5000 };

describe('cash register opening balance posts to the ledger', () => {
  it('posts Dr cash / Cr capital for the opening amount', async () => {
    findById.mockResolvedValue(cashAcc);
    findByCode.mockResolvedValue(capAcc);
    const { svc, journal, repo } = make(5000);
    await svc.createRegister(C, input, 'u1');
    const lines = journal.createDraftEntry.mock.calls[0][1].lines;
    expect(lines[0]).toMatchObject({ accountId: CASH, debit: 5000, credit: 0 });
    expect(lines[1]).toMatchObject({ accountId: CAP, debit: 0, credit: 5000 });
    expect(journal.postEntry).toHaveBeenCalledTimes(1);
    expect(repo.setOpeningEntryId).toHaveBeenCalledWith(C, 'r1', 'je1', expect.anything());
  });
  it('posts nothing when opening is zero', async () => {
    findById.mockResolvedValue(cashAcc);
    const { svc, journal } = make(0);
    await svc.createRegister(C, { ...input, openingBalance: 0 }, 'u1');
    expect(journal.createDraftEntry).not.toHaveBeenCalled();
  });
  it('rejects when no equity offset account exists', async () => {
    findById.mockResolvedValue(cashAcc);
    findByCode.mockResolvedValue(null);
    const { svc } = make(5000);
    await expect(svc.createRegister(C, input, 'u1')).rejects.toBeInstanceOf(ValidationError);
  });
  it('rejects a non-equity offset account', async () => {
    findById.mockImplementation(async (_c: string, id: string) => (id === CASH ? cashAcc : { ...capAcc, accountType: 'asset' }));
    const { svc } = make(5000);
    await expect(svc.createRegister(C, { ...input, openingOffsetAccountId: CAP }, 'u1')).rejects.toBeInstanceOf(ValidationError);
  });
  it('postOpeningBalance posts once and refuses a second time', async () => {
    findById.mockResolvedValue(capAcc);
    const { svc, repo, journal } = make(5000);
    await svc.postOpeningBalance(C, '22222222-2222-4222-8222-222222222222', CAP, 'u1');
    expect(journal.postEntry).toHaveBeenCalledTimes(1);
    repo.getOpeningEntryId.mockResolvedValue('je1');
    await expect(svc.postOpeningBalance(C, '22222222-2222-4222-8222-222222222222', CAP, 'u1')).rejects.toBeInstanceOf(ValidationError);
  });
});
