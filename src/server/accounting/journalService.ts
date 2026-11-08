import { defaultJournalRepository, JournalRepository } from './journalRepository.js';
import { defaultAccountRepository, AccountRepository } from './accountRepository.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { defaultAuditService } from '../audit/auditService.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import {
  JournalEntry,
  CreateDraftJournalEntryInput,
  CreateJournalLineInput,
} from './journalTypes.js';

export class JournalService {
  constructor(
    private journalRepo: JournalRepository = defaultJournalRepository,
    private accountRepo: AccountRepository = defaultAccountRepository
  ) {}

  /**
   * 1. Create a draft journal entry.
   * Validates accounts belong to the company, are postable and active, and line amounts are valid.
   */
  async createDraftEntry(
    companyId: string,
    input: CreateDraftJournalEntryInput,
    actorId?: string
  ): Promise<JournalEntry> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    if (!input.entryDate || typeof input.entryDate !== 'string') {
      throw new ValidationError('entryDate is required (YYYY-MM-DD)');
    }

    if (!input.lines || !Array.isArray(input.lines) || input.lines.length < 2) {
      throw new ValidationError('Journal entry must have at least two lines');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      // Validate accounts existence, active state, and postability
      for (const line of input.lines) {
        if (!line.accountId) {
          throw new ValidationError('Each line must reference an accountId');
        }

        const debit = Number(line.debit) || 0;
        const credit = Number(line.credit) || 0;

        if (debit < 0 || credit < 0) {
          throw new ValidationError('Debit and credit amounts cannot be negative');
        }

        if (debit === 0 && credit === 0) {
          throw new ValidationError('Line must have either debit or credit greater than 0');
        }

        if (debit > 0 && credit > 0) {
          throw new ValidationError('Line cannot have both debit and credit greater than 0 (single sided)');
        }

        const account = await this.accountRepo.findById(companyId, line.accountId, tx);
        if (!account) {
          throw new ValidationError(`Account ${line.accountId} not found in this company`);
        }

        if (!account.isActive) {
          throw new ValidationError(`Account ${account.code} (${account.nameAr}) is inactive`);
        }

        if (!account.isPostable) {
          throw new ValidationError(`Account ${account.code} (${account.nameAr}) is a parent/header account and not postable`);
        }
      }

      const draft = await this.journalRepo.createDraft(
        companyId,
        input.entryDate,
        input.memo || null,
        input.lines,
        actorId,
        tx
      );

      await defaultAuditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'JOURNAL_DRAFT_CREATE',
        entityType: 'journal_entry',
        entityId: draft.id,
        metadata: {
          entryDate: draft.entryDate,
          linesCount: input.lines.length,
        },
      });

      return draft;
    });
  }

  /**
   * 2. Post a journal entry.
   * Strict double-entry balance check: SUM(debit) === SUM(credit) > 0.
   * Allocates sequence number from accounting_sequences inside the same transaction.
   */
  async postEntry(
    companyId: string,
    entryId: string,
    actorId: string
  ): Promise<JournalEntry> {
    if (!companyId || !entryId) {
      throw new ValidationError('companyId and entryId are required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const entry = await this.journalRepo.findById(companyId, entryId, tx);
      if (!entry) {
        throw new NotFoundError('Journal entry not found');
      }

      if (entry.status !== 'draft') {
        throw new ValidationError(`Cannot post entry with status '${entry.status}'. Entry must be in draft status.`);
      }

      const lines = entry.lines || [];
      if (lines.length < 2) {
        throw new ValidationError('Cannot post entry with fewer than two lines');
      }

      // Calculate totals with cent precision
      let totalDebit = 0;
      let totalCredit = 0;

      for (const line of lines) {
        totalDebit += Math.round((line.debit || 0) * 100);
        totalCredit += Math.round((line.credit || 0) * 100);
      }

      if (totalDebit <= 0) {
        throw new ValidationError('Entry amounts must be greater than zero');
      }

      if (totalDebit !== totalCredit) {
        throw new ValidationError(
          `Unbalanced journal entry: Total debit (${(totalDebit / 100).toFixed(2)}) must equal total credit (${(totalCredit / 100).toFixed(2)})`
        );
      }

      // Allocate unique monotonic entry number from sequence
      const entryNo = await this.journalRepo.allocateSequenceNumber(
        companyId,
        'journal_entry',
        'JE',
        tx
      );

      const updated = await this.journalRepo.updateStatusToPosted(
        companyId,
        entryId,
        entryNo,
        actorId,
        tx
      );

      if (!updated) {
        throw new ValidationError('Failed to post journal entry (it may have already been posted)');
      }

      await defaultAuditService.record({
        actorUserId: actorId,
        companyId,
        action: 'JOURNAL_POST',
        entityType: 'journal_entry',
        entityId: entryId,
        metadata: {
          entryNo,
          totalAmount: totalDebit / 100,
        },
      });

      const postedEntry = await this.journalRepo.findById(companyId, entryId, tx);
      return postedEntry!;
    });
  }

  /**
   * 3. Reverse a posted journal entry.
   * Source entry must be posted and not previously reversed.
   * Creates a new reversing entry with swapped debit/credits, posts it immediately,
   * and links reversed_by_entry_id on the original entry.
   */
  async reverseEntry(
    companyId: string,
    entryId: string,
    actorId: string,
    reversalMemo?: string
  ): Promise<JournalEntry> {
    if (!companyId || !entryId) {
      throw new ValidationError('companyId and entryId are required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const source = await this.journalRepo.findById(companyId, entryId, tx);
      if (!source) {
        throw new NotFoundError('Source journal entry not found');
      }

      if (source.status !== 'posted') {
        throw new ValidationError('Only posted journal entries can be reversed');
      }

      if (source.reversedByEntryId) {
        throw new ValidationError(`This journal entry has already been reversed by entry ${source.reversedByEntryId}`);
      }

      const sourceLines = source.lines || [];
      if (sourceLines.length === 0) {
        throw new ValidationError('Source entry has no lines to reverse');
      }

      // Build reversing lines with swapped debit and credit
      const reversingLines: CreateJournalLineInput[] = sourceLines.map((l) => ({
        accountId: l.accountId,
        debit: l.credit, // swap
        credit: l.debit, // swap
        lineMemo: l.lineMemo ? `[عكس] ${l.lineMemo}` : `عكس قيد ${source.entryNo || source.id}`,
      }));

      const today = new Date().toISOString().split('T')[0];
      const memo = reversalMemo || `عكس القيد المحاسبي رقم ${source.entryNo || source.id}: ${source.memo || ''}`;

      // 1. Create reversing draft
      const draftReversal = await this.journalRepo.createDraft(
        companyId,
        today,
        memo,
        reversingLines,
        actorId,
        tx
      );

      // 2. Allocate sequence number for reversal
      const reversalEntryNo = await this.journalRepo.allocateSequenceNumber(
        companyId,
        'journal_entry',
        'JE',
        tx
      );

      // 3. Post reversal entry
      await this.journalRepo.updateStatusToPosted(
        companyId,
        draftReversal.id,
        reversalEntryNo,
        actorId,
        tx
      );

      // 4. Link reversed_by_entry_id on original entry
      await this.journalRepo.linkReversal(
        companyId,
        source.id,
        draftReversal.id,
        tx
      );

      await defaultAuditService.record({
        actorUserId: actorId,
        companyId,
        action: 'JOURNAL_REVERSE',
        entityType: 'journal_entry',
        entityId: source.id,
        metadata: {
          originalEntryNo: source.entryNo,
          reversalEntryId: draftReversal.id,
          reversalEntryNo,
        },
      });

      const finalReversal = await this.journalRepo.findById(companyId, draftReversal.id, tx);
      return finalReversal!;
    });
  }

  /**
   * 4. List journal entries for a company.
   */
  async listEntries(companyId: string, limit: number = 50, offset: number = 0): Promise<JournalEntry[]> {
    return await this.journalRepo.list(companyId, limit, offset);
  }

  /**
   * 5. Get single entry with lines.
   */
  async getEntry(companyId: string, entryId: string): Promise<JournalEntry | null> {
    return await this.journalRepo.findById(companyId, entryId);
  }
}

export const defaultJournalService = new JournalService();
