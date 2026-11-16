import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import {
  BankStatementLine,
  CreateBankStatementLineInput,
  GlBookMovementRow,
  BankReconciliation,
} from './bankingTypes.js';
import { toMinorUnits, fromMinorUnits } from '../lib/numeric.js';

function mapStatementLine(row: any): BankStatementLine {
  return {
    id: row.id,
    companyId: row.companyId,
    bankAccountId: row.bankAccountId,
    statementDate: String(row.statementDate).slice(0, 10),
    valueDate: row.valueDate ? String(row.valueDate).slice(0, 10) : null,
    reference: row.reference ?? null,
    description: row.description,
    debitAmount: fromMinorUnits(toMinorUnits(row.debitAmount ?? '0', 2), 2),
    creditAmount: fromMinorUnits(toMinorUnits(row.creditAmount ?? '0', 2), 2),
    status: row.status === 'matched' ? 'matched' : 'unmatched',
    matchedJournalLineId: row.matchedJournalLineId ?? null,
    matchedEntryNo: row.matchedEntryNo ?? null,
    matchedEntryDate: row.matchedEntryDate ? String(row.matchedEntryDate).slice(0, 10) : null,
    reconciliationId: row.reconciliationId ?? null,
    matchedAt: row.matchedAt
      ? typeof row.matchedAt === 'string'
        ? row.matchedAt
        : new Date(row.matchedAt).toISOString()
      : null,
    matchedBy: row.matchedBy ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(row.createdAt).toISOString(),
  };
}

function mapReconciliation(row: any): BankReconciliation {
  return {
    id: row.id,
    companyId: row.companyId,
    bankAccountId: row.bankAccountId,
    statementEndDate: String(row.statementEndDate).slice(0, 10),
    statementEndingBalance: fromMinorUnits(toMinorUnits(row.statementEndingBalance ?? '0', 2), 2),
    bookBalance: fromMinorUnits(toMinorUnits(row.bookBalance ?? '0', 2), 2),
    unmatchedStatementNet: fromMinorUnits(toMinorUnits(row.unmatchedStatementNet ?? '0', 2), 2),
    unmatchedBookNet: fromMinorUnits(toMinorUnits(row.unmatchedBookNet ?? '0', 2), 2),
    differenceAmount: fromMinorUnits(toMinorUnits(row.differenceAmount ?? '0', 2), 2),
    status: row.status === 'completed' ? 'completed' : 'draft',
    memo: row.memo ?? null,
    completedAt: row.completedAt
      ? typeof row.completedAt === 'string'
        ? row.completedAt
        : new Date(row.completedAt).toISOString()
      : null,
    completedBy: row.completedBy ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(row.createdAt).toISOString(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date(row.updatedAt).toISOString(),
  };
}

export class BankReconcileRepository {
  async listStatementLines(
    companyId: string,
    bankAccountId: string,
    asOfDate?: string,
    customExecutor?: DbExecutor
  ): Promise<BankStatementLine[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          sl.id,
          sl.company_id as "companyId",
          sl.bank_account_id as "bankAccountId",
          sl.statement_date::text as "statementDate",
          sl.value_date::text as "valueDate",
          sl.reference,
          sl.description,
          sl.debit_amount::text as "debitAmount",
          sl.credit_amount::text as "creditAmount",
          sl.status,
          sl.matched_journal_line_id as "matchedJournalLineId",
          je.entry_no as "matchedEntryNo",
          je.entry_date::text as "matchedEntryDate",
          sl.reconciliation_id as "reconciliationId",
          sl.matched_at as "matchedAt",
          sl.matched_by as "matchedBy",
          sl.created_by as "createdBy",
          sl.created_at as "createdAt"
        FROM fin_bank_statement_lines sl
        LEFT JOIN journal_lines jl ON jl.id = sl.matched_journal_line_id AND jl.company_id = sl.company_id
        LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.company_id = jl.company_id
        WHERE sl.company_id = $1
          AND sl.bank_account_id = $2
          AND ($3::date IS NULL OR sl.statement_date <= $3::date)
        ORDER BY sl.statement_date DESC, sl.created_at DESC;
      `;
      const res = await executor.query(sql, [companyId, bankAccountId, asOfDate || null]);
      return res.rows.map(mapStatementLine);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findStatementLineForUpdate(
    companyId: string,
    lineId: string,
    tx: DbExecutor
  ): Promise<BankStatementLine | null> {
    const sql = `
      SELECT
        id,
        company_id as "companyId",
        bank_account_id as "bankAccountId",
        statement_date::text as "statementDate",
        value_date::text as "valueDate",
        reference,
        description,
        debit_amount::text as "debitAmount",
        credit_amount::text as "creditAmount",
        status,
        matched_journal_line_id as "matchedJournalLineId",
        reconciliation_id as "reconciliationId",
        matched_at as "matchedAt",
        matched_by as "matchedBy",
        created_by as "createdBy",
        created_at as "createdAt"
      FROM fin_bank_statement_lines
      WHERE company_id = $1 AND id = $2
      FOR UPDATE;
    `;
    const res = await tx.query(sql, [companyId, lineId]);
    if (res.rows.length === 0) return null;
    return mapStatementLine(res.rows[0]);
  }

  async insertStatementLines(
    companyId: string,
    bankAccountId: string,
    lines: CreateBankStatementLineInput[],
    actorId: string | null,
    tx: DbExecutor
  ): Promise<BankStatementLine[]> {
    const inserted: BankStatementLine[] = [];
    for (const line of lines) {
      const debit = fromMinorUnits(toMinorUnits(line.debitAmount ?? 0, 2), 2);
      const credit = fromMinorUnits(toMinorUnits(line.creditAmount ?? 0, 2), 2);
      const sql = `
        INSERT INTO fin_bank_statement_lines (
          company_id, bank_account_id, statement_date, value_date,
          reference, description, debit_amount, credit_amount, status, created_by
        )
        VALUES ($1, $2, $3::date, $4::date, $5, $6, $7::numeric, $8::numeric, 'unmatched', $9)
        RETURNING
          id,
          company_id as "companyId",
          bank_account_id as "bankAccountId",
          statement_date::text as "statementDate",
          value_date::text as "valueDate",
          reference,
          description,
          debit_amount::text as "debitAmount",
          credit_amount::text as "creditAmount",
          status,
          matched_journal_line_id as "matchedJournalLineId",
          reconciliation_id as "reconciliationId",
          matched_at as "matchedAt",
          matched_by as "matchedBy",
          created_by as "createdBy",
          created_at as "createdAt";
      `;
      const res = await tx.query(sql, [
        companyId,
        bankAccountId,
        line.statementDate,
        line.valueDate || null,
        line.reference?.trim() || null,
        line.description.trim(),
        debit,
        credit,
        actorId,
      ]);
      inserted.push(mapStatementLine(res.rows[0]));
    }
    return inserted;
  }

  async listPostedGlMovements(
    companyId: string,
    glAccountId: string,
    bankAccountId: string,
    asOfDate?: string,
    customExecutor?: DbExecutor
  ): Promise<GlBookMovementRow[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          jl.id as "journalLineId",
          je.id as "entryId",
          je.entry_no as "entryNo",
          je.entry_date::text as "entryDate",
          je.memo as "entryMemo",
          jl.line_memo as "lineMemo",
          jl.debit::text as "debit",
          jl.credit::text as "credit",
          (sl.id IS NOT NULL) as "isMatched",
          sl.id as "matchedStatementLineId"
        FROM journal_lines jl
        INNER JOIN journal_entries je ON je.id = jl.entry_id AND je.company_id = jl.company_id
        LEFT JOIN fin_bank_statement_lines sl
          ON sl.matched_journal_line_id = jl.id
          AND sl.company_id = jl.company_id
          AND sl.bank_account_id = $3
        WHERE jl.company_id = $1
          AND jl.account_id = $2
          AND je.status = 'posted'
          AND ($4::date IS NULL OR je.entry_date <= $4::date)
        ORDER BY je.entry_date DESC, je.created_at DESC, jl.id ASC;
      `;
      const res = await executor.query(sql, [companyId, glAccountId, bankAccountId, asOfDate || null]);
      return res.rows.map((r: any) => ({
        journalLineId: r.journalLineId,
        entryId: r.entryId,
        entryNo: r.entryNo ?? null,
        entryDate: String(r.entryDate).slice(0, 10),
        entryMemo: r.entryMemo ?? null,
        lineMemo: r.lineMemo ?? null,
        debit: fromMinorUnits(toMinorUnits(r.debit ?? '0', 2), 2),
        credit: fromMinorUnits(toMinorUnits(r.credit ?? '0', 2), 2),
        isMatched: Boolean(r.isMatched),
        matchedStatementLineId: r.matchedStatementLineId ?? null,
      }));
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findPostedGlLineForBank(
    companyId: string,
    glAccountId: string,
    journalLineId: string,
    tx: DbExecutor
  ): Promise<{ id: string; debit: string; credit: string; entryDate: string } | null> {
    const sql = `
      SELECT
        jl.id,
        jl.debit::text as "debit",
        jl.credit::text as "credit",
        je.entry_date::text as "entryDate"
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.entry_id AND je.company_id = jl.company_id
      WHERE jl.company_id = $1
        AND jl.id = $2
        AND jl.account_id = $3
        AND je.status = 'posted'
      FOR UPDATE OF jl;
    `;
    const res = await tx.query<{ id: string; debit: string; credit: string; entryDate: string }>(sql, [companyId, journalLineId, glAccountId]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async findMatchedByJournalLine(
    companyId: string,
    journalLineId: string,
    tx: DbExecutor
  ): Promise<{ id: string } | null> {
    const sql = `
      SELECT id
      FROM fin_bank_statement_lines
      WHERE company_id = $1 AND matched_journal_line_id = $2
      LIMIT 1;
    `;
    const res = await tx.query<{ id: string }>(sql, [companyId, journalLineId]);
    return res.rows[0] || null;
  }

  async setStatementLineMatch(
    companyId: string,
    statementLineId: string,
    journalLineId: string | null,
    actorId: string | null,
    tx: DbExecutor
  ): Promise<BankStatementLine> {
    const status = journalLineId ? 'matched' : 'unmatched';
    const sql = `
      UPDATE fin_bank_statement_lines
      SET
        status = $3,
        matched_journal_line_id = $4,
        matched_at = CASE WHEN $4 IS NOT NULL THEN NOW() ELSE NULL END,
        matched_by = CASE WHEN $4 IS NOT NULL THEN $5 ELSE NULL END
      WHERE company_id = $1 AND id = $2
      RETURNING
        id,
        company_id as "companyId",
        bank_account_id as "bankAccountId",
        statement_date::text as "statementDate",
        value_date::text as "valueDate",
        reference,
        description,
        debit_amount::text as "debitAmount",
        credit_amount::text as "creditAmount",
        status,
        matched_journal_line_id as "matchedJournalLineId",
        reconciliation_id as "reconciliationId",
        matched_at as "matchedAt",
        matched_by as "matchedBy",
        created_by as "createdBy",
        created_at as "createdAt";
    `;
    const res = await tx.query(sql, [companyId, statementLineId, status, journalLineId, actorId]);
    return mapStatementLine(res.rows[0]);
  }

  async listReconciliations(
    companyId: string,
    bankAccountId: string,
    customExecutor?: DbExecutor
  ): Promise<BankReconciliation[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          id,
          company_id as "companyId",
          bank_account_id as "bankAccountId",
          statement_end_date::text as "statementEndDate",
          statement_ending_balance::text as "statementEndingBalance",
          book_balance::text as "bookBalance",
          unmatched_statement_net::text as "unmatchedStatementNet",
          unmatched_book_net::text as "unmatchedBookNet",
          difference_amount::text as "differenceAmount",
          status,
          memo,
          completed_at as "completedAt",
          completed_by as "completedBy",
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt"
        FROM fin_bank_reconciliations
        WHERE company_id = $1 AND bank_account_id = $2
        ORDER BY statement_end_date DESC, created_at DESC;
      `;
      const res = await executor.query(sql, [companyId, bankAccountId]);
      return res.rows.map(mapReconciliation);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async createCompletedReconciliation(
    companyId: string,
    data: {
      bankAccountId: string;
      statementEndDate: string;
      statementEndingBalance: string;
      bookBalance: string;
      unmatchedStatementNet: string;
      unmatchedBookNet: string;
      differenceAmount: string;
      memo: string | null;
      actorId: string | null;
    },
    tx: DbExecutor
  ): Promise<BankReconciliation> {
    const sql = `
      INSERT INTO fin_bank_reconciliations (
        company_id, bank_account_id, statement_end_date,
        statement_ending_balance, book_balance,
        unmatched_statement_net, unmatched_book_net, difference_amount,
        status, memo, completed_at, completed_by, created_by
      )
      VALUES (
        $1, $2, $3::date,
        $4::numeric, $5::numeric,
        $6::numeric, $7::numeric, $8::numeric,
        'completed', $9, NOW(), $10, $10
      )
      RETURNING
        id,
        company_id as "companyId",
        bank_account_id as "bankAccountId",
        statement_end_date::text as "statementEndDate",
        statement_ending_balance::text as "statementEndingBalance",
        book_balance::text as "bookBalance",
        unmatched_statement_net::text as "unmatchedStatementNet",
        unmatched_book_net::text as "unmatchedBookNet",
        difference_amount::text as "differenceAmount",
        status,
        memo,
        completed_at as "completedAt",
        completed_by as "completedBy",
        created_by as "createdBy",
        created_at as "createdAt",
        updated_at as "updatedAt";
    `;
    const res = await tx.query(sql, [
      companyId,
      data.bankAccountId,
      data.statementEndDate,
      data.statementEndingBalance,
      data.bookBalance,
      data.unmatchedStatementNet,
      data.unmatchedBookNet,
      data.differenceAmount,
      data.memo,
      data.actorId,
    ]);
    return mapReconciliation(res.rows[0]);
  }

  async linkMatchedLinesToReconciliation(
    companyId: string,
    bankAccountId: string,
    asOfDate: string,
    reconciliationId: string,
    tx: DbExecutor
  ): Promise<number> {
    const sql = `
      UPDATE fin_bank_statement_lines
      SET reconciliation_id = $4
      WHERE company_id = $1
        AND bank_account_id = $2
        AND status = 'matched'
        AND reconciliation_id IS NULL
        AND statement_date <= $3::date;
    `;
    const res = await tx.query(sql, [companyId, bankAccountId, asOfDate, reconciliationId]);
    return res.rowCount ?? 0;
  }
}

export const defaultBankReconcileRepository = new BankReconcileRepository();
