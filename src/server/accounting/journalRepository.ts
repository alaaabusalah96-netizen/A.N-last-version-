import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { JournalEntry, JournalLine, CreateJournalLineInput } from './journalTypes.js';

export class JournalRepository {
  /**
   * Allocate the next monotonic sequence number for a document type (e.g. 'journal_entry').
   * Uses SELECT ... FOR UPDATE within a tenant transaction to prevent race conditions or duplicate numbers.
   */
  async allocateSequenceNumber(
    companyId: string,
    docType: string,
    prefix: string = 'JE',
    customExecutor?: DbExecutor
  ): Promise<string> {
    const run = async (executor: DbExecutor) => {
      // Ensure row exists
      await executor.query(
        `INSERT INTO accounting_sequences (company_id, doc_type, prefix, next_value, updated_at)
         VALUES ($1, $2, $3, 1, NOW())
         ON CONFLICT (company_id, doc_type) DO NOTHING`,
        [companyId, docType, prefix]
      );

      // Lock row and fetch next value
      const res = await executor.query<{ prefix: string | null; next_value: string }>(
        `SELECT prefix, next_value
         FROM accounting_sequences
         WHERE company_id = $1 AND doc_type = $2
         FOR UPDATE`,
        [companyId, docType]
      );

      const row = res.rows[0];
      const currentVal = parseInt(row.next_value, 10);
      const nextVal = currentVal + 1;

      // Update next value
      await executor.query(
        `UPDATE accounting_sequences
         SET next_value = $3, updated_at = NOW()
         WHERE company_id = $1 AND doc_type = $2`,
        [companyId, docType, nextVal]
      );

      const activePrefix = row.prefix || prefix;
      const paddedNumber = String(currentVal).padStart(6, '0');
      return `${activePrefix}-${paddedNumber}`;
    };

    if (customExecutor) {
      return await run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Create a draft journal entry and its child lines atomically.
   */
  async createDraft(
    companyId: string,
    entryDate: string,
    memo: string | null,
    lines: CreateJournalLineInput[],
    actorId?: string,
    customExecutor?: DbExecutor
  ): Promise<JournalEntry> {
    const run = async (executor: DbExecutor) => {
      const entrySql = `
        INSERT INTO journal_entries (company_id, entry_date, memo, status, created_by, created_at)
        VALUES ($1, $2, $3, 'draft', $4, NOW())
        RETURNING 
          id, 
          company_id as "companyId", 
          entry_date as "entryDate", 
          entry_no as "entryNo",
          memo, 
          status, 
          period_id as "periodId",
          posted_at as "postedAt",
          posted_by as "postedBy",
          reversed_by_entry_id as "reversedByEntryId",
          created_by as "createdBy", 
          created_at as "createdAt"
      `;
      const entryRes = await executor.query<JournalEntry>(entrySql, [
        companyId,
        entryDate,
        memo,
        actorId || null,
      ]);
      const entry = entryRes.rows[0];

      const insertedLines: JournalLine[] = [];
      for (const line of lines) {
        const lineSql = `
          INSERT INTO journal_lines (company_id, entry_id, account_id, debit, credit, line_memo)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING 
            id, 
            company_id as "companyId", 
            entry_id as "entryId", 
            account_id as "accountId", 
            debit::float, 
            credit::float, 
            line_memo as "lineMemo"
        `;
        const lineRes = await executor.query<JournalLine>(lineSql, [
          companyId,
          entry.id,
          line.accountId,
          line.debit,
          line.credit,
          line.lineMemo || null,
        ]);
        insertedLines.push(lineRes.rows[0]);
      }

      entry.lines = insertedLines;
      return entry;
    };

    if (customExecutor) {
      return await run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Find a journal entry by ID.
   */
  async findById(
    companyId: string,
    entryId: string,
    customExecutor?: DbExecutor
  ): Promise<JournalEntry | null> {
    const run = async (executor: DbExecutor) => {
      const entrySql = `
        SELECT 
          id, 
          company_id as "companyId", 
          entry_date::text as "entryDate", 
          entry_no as "entryNo",
          memo, 
          status, 
          period_id as "periodId",
          posted_at as "postedAt",
          posted_by as "postedBy",
          reversed_by_entry_id as "reversedByEntryId",
          created_by as "createdBy", 
          created_at as "createdAt"
        FROM journal_entries
        WHERE id = $1 AND company_id = $2
      `;
      const res = await executor.query<JournalEntry>(entrySql, [entryId, companyId]);
      if (res.rows.length === 0) return null;

      const entry = res.rows[0];

      const linesSql = `
        SELECT 
          l.id, 
          l.company_id as "companyId", 
          l.entry_id as "entryId", 
          l.account_id as "accountId", 
          l.debit::float, 
          l.credit::float, 
          l.line_memo as "lineMemo",
          a.code as "accountCode",
          a.name_ar as "accountNameAr"
        FROM journal_lines l
        LEFT JOIN accounts a ON l.account_id = a.id
        WHERE l.entry_id = $1 AND l.company_id = $2
        ORDER BY l.debit DESC, l.credit DESC
      `;
      const linesRes = await executor.query<JournalLine>(linesSql, [entryId, companyId]);
      entry.lines = linesRes.rows;
      return entry;
    };

    if (customExecutor) {
      return await run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  /**
   * List journal entries for a company.
   */
  async list(
    companyId: string,
    limit: number = 50,
    offset: number = 0,
    customExecutor?: DbExecutor
  ): Promise<JournalEntry[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          id, 
          company_id as "companyId", 
          entry_date::text as "entryDate", 
          entry_no as "entryNo",
          memo, 
          status, 
          period_id as "periodId",
          posted_at as "postedAt",
          posted_by as "postedBy",
          reversed_by_entry_id as "reversedByEntryId",
          created_by as "createdBy", 
          created_at as "createdAt"
        FROM journal_entries
        WHERE company_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `;
      const res = await executor.query<JournalEntry>(sql, [companyId, limit, offset]);
      return res.rows;
    };

    if (customExecutor) {
      return await run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Mark an entry as posted, setting entry_no, posted_at, posted_by, and status='posted'.
   */
  async updateStatusToPosted(
    companyId: string,
    entryId: string,
    entryNo: string,
    actorId: string,
    customExecutor?: DbExecutor
  ): Promise<boolean> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        UPDATE journal_entries
        SET 
          status = 'posted',
          entry_no = $3,
          posted_at = NOW(),
          posted_by = $4
        WHERE id = $1 AND company_id = $2 AND status = 'draft'
      `;
      const res = await executor.query(sql, [entryId, companyId, entryNo, actorId]);
      return (res.rowCount ?? 0) === 1;
    };

    if (customExecutor) {
      return await run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Link an original posted entry to its reversing entry (via reversed_by_entry_id).
   */
  async linkReversal(
    companyId: string,
    originalEntryId: string,
    reversingEntryId: string,
    customExecutor?: DbExecutor
  ): Promise<boolean> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        UPDATE journal_entries
        SET reversed_by_entry_id = $3
        WHERE id = $1 AND company_id = $2 AND status = 'posted' AND reversed_by_entry_id IS NULL
      `;
      const res = await executor.query(sql, [originalEntryId, companyId, reversingEntryId]);
      return (res.rowCount ?? 0) === 1;
    };

    if (customExecutor) {
      return await run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultJournalRepository = new JournalRepository();
