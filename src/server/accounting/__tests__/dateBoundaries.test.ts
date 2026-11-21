import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PeriodService } from '../periodService.js';
import { JournalService } from '../journalService.js';
import { ValidationError } from '../../http/errors.js';

const COMP_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const ACC_1 = '33333333-3333-4333-8333-333333333331';
const ACC_2 = '33333333-3333-4333-8333-333333333332';
const ENTRY_ID = '44444444-4444-4444-8444-444444444444';
const REV_ENTRY_ID = '55555555-5555-4555-8555-555555555555';
const PERIOD_ID = '66666666-6666-4666-8666-666666666666';

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn((_companyId: string, callback: (tx: unknown) => Promise<unknown>) =>
    callback(mockTx)
  ),
}));

let mockTx: { query: ReturnType<typeof vi.fn> };

describe('R01 Period & Journal Date Boundaries Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = {
      query: vi.fn().mockResolvedValue({ rows: [{ timezone: 'Africa/Cairo' }] }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('PeriodService.createPeriod', () => {
    it('rejects impossible calendar dates and accepts leap day 2028-02-29', async () => {
      const periodRepo = {
        findByCode: vi.fn().mockResolvedValue(null),
        findOverlapping: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async (_cid, input) => ({
          id: PERIOD_ID,
          companyId: COMP_ID,
          code: input.code,
          startDate: input.startDate,
          endDate: input.endDate,
          isClosed: false,
          closedAt: null,
          closedBy: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        })),
      } as any;
      const auditService = { record: vi.fn().mockResolvedValue(undefined) } as any;
      const service = new PeriodService(periodRepo, auditService);

      await expect(
        service.createPeriod(COMP_ID, { code: 'BAD-1', startDate: '2026-02-29', endDate: '2026-03-31' }, ACTOR_ID)
      ).rejects.toThrow(ValidationError);

      await expect(
        service.createPeriod(COMP_ID, { code: 'BAD-2', startDate: '2026-04-01', endDate: '2026-04-31' }, ACTOR_ID)
      ).rejects.toThrow(ValidationError);

      await expect(
        service.createPeriod(COMP_ID, { code: 'BAD-3', startDate: '2026-13-01', endDate: '2026-12-31' }, ACTOR_ID)
      ).rejects.toThrow(ValidationError);

      await expect(
        service.createPeriod(COMP_ID, { code: 'REV-1', startDate: '2026-03-31', endDate: '2026-03-01' }, ACTOR_ID)
      ).rejects.toThrow(ValidationError);

      const leapPeriod = await service.createPeriod(
        COMP_ID,
        { code: '2028-02', startDate: '2028-02-01', endDate: '2028-02-29' },
        ACTOR_ID
      );
      expect(leapPeriod.startDate).toBe('2028-02-01');
      expect(leapPeriod.endDate).toBe('2028-02-29');
    });

    it('rejects overlapping accounting period ranges', async () => {
      const periodRepo = {
        findByCode: vi.fn().mockResolvedValue(null),
        findOverlapping: vi.fn().mockResolvedValue({
          id: PERIOD_ID,
          code: '2026-03',
          startDate: '2026-03-01',
          endDate: '2026-03-31',
        }),
      } as any;
      const service = new PeriodService(periodRepo, { record: vi.fn() } as any);

      await expect(
        service.createPeriod(COMP_ID, { code: '2026-03-B', startDate: '2026-03-15', endDate: '2026-04-15' }, ACTOR_ID)
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('JournalService date validation and period enforcement', () => {
    it('rejects impossible entryDate on createDraftEntry', async () => {
      const journalService = new JournalService({} as any, {} as any, {} as any);
      const lines = [
        { accountId: ACC_1, debit: 100, credit: 0 },
        { accountId: ACC_2, debit: 0, credit: 100 },
      ];

      await expect(
        journalService.createDraftEntry(COMP_ID, { entryDate: '2026-02-29', lines }, undefined, true, mockTx as any)
      ).rejects.toThrow(ValidationError);

      await expect(
        journalService.createDraftEntry(COMP_ID, { entryDate: '2026-04-31', lines }, undefined, true, mockTx as any)
      ).rejects.toThrow(ValidationError);
    });

    it('enforces closed period and missing period boundaries on postEntry', async () => {
      const makeEntry = (entryDate: string) => ({
        id: ENTRY_ID,
        companyId: COMP_ID,
        entryDate,
        status: 'draft',
        periodId: null,
        orgUnitId: null,
        lines: [
          { id: 'l1', accountId: ACC_1, debit: 100, credit: 0 },
          { id: 'l2', accountId: ACC_2, debit: 0, credit: 100 },
        ],
      });

      const journalRepo = {
        findByIdForUpdate: vi
          .fn()
          .mockResolvedValueOnce(makeEntry('2026-04-01'))
          .mockResolvedValueOnce(makeEntry('2026-03-15')),
      } as any;

      const periodRepo = {
        findCoveringDateForUpdate: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: PERIOD_ID,
            code: '2026-03',
            startDate: '2026-03-01',
            endDate: '2026-03-31',
            isClosed: true,
          }),
      } as any;

      const journalService = new JournalService(journalRepo, {} as any, periodRepo);

      await expect(
        journalService.postEntry(COMP_ID, ENTRY_ID, '', true, mockTx as any)
      ).rejects.toThrow(ValidationError);

      await expect(
        journalService.postEntry(COMP_ID, ENTRY_ID, '', true, mockTx as any)
      ).rejects.toThrow(ValidationError);
    });

    it('uses company business timezone for reverseEntry near UTC midnight', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-01T22:30:00.000Z'));

      const journalRepo = {
        findByIdForUpdate: vi.fn().mockResolvedValue({
          id: ENTRY_ID,
          companyId: COMP_ID,
          entryDate: '2026-03-01',
          entryNo: 'JE-000001',
          memo: 'original',
          status: 'posted',
          periodId: PERIOD_ID,
          reversedByEntryId: null,
          orgUnitId: null,
          lines: [
            { id: 'l1', accountId: ACC_1, debit: 100, credit: 0 },
            { id: 'l2', accountId: ACC_2, debit: 0, credit: 100 },
          ],
        }),
        createDraft: vi.fn().mockImplementation(async (_cid, entryDate) => ({
          id: REV_ENTRY_ID,
          companyId: COMP_ID,
          entryDate,
          status: 'draft',
        })),
        allocateSequenceNumber: vi.fn().mockResolvedValue('JE-000002'),
        updateStatusToPosted: vi.fn().mockResolvedValue(true),
        linkReversal: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue({
          id: REV_ENTRY_ID,
          companyId: COMP_ID,
          entryDate: '2026-03-02',
          entryNo: 'JE-000002',
          status: 'posted',
        }),
      } as any;

      const periodRepo = {
        findCoveringDateForUpdate: vi.fn().mockResolvedValue({
          id: PERIOD_ID,
          companyId: COMP_ID,
          code: '2026-03',
          startDate: '2026-03-01',
          endDate: '2026-03-31',
          isClosed: false,
        }),
      } as any;

      const journalService = new JournalService(journalRepo, {} as any, periodRepo);
      const reversed = await journalService.reverseEntry(COMP_ID, ENTRY_ID, '', undefined, true, mockTx as any);

      expect(periodRepo.findCoveringDateForUpdate).toHaveBeenCalledWith(COMP_ID, '2026-03-02', mockTx);
      expect(journalRepo.createDraft).toHaveBeenCalledWith(
        COMP_ID,
        '2026-03-02',
        expect.any(String),
        expect.any(Array),
        '',
        null,
        mockTx
      );
      expect(reversed.entryDate).toBe('2026-03-02');
    });
  });
});
