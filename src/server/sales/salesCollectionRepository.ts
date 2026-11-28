import { DbExecutor } from '../db/index.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { SalesCollection, SalesCollectionLine, CreateSalesCollectionInput } from './salesTypes.js';
import { toCalendarDate } from '../lib/calendarDate.js';

function mapRow(row: any): SalesCollection {
  return {
    id: row.id,
    companyId: row.company_id,
    customerId: row.customer_id,
    customerCode: row.customer_code,
    customerNameAr: row.customer_name_ar,
    invoiceId: row.invoice_id,
    invoiceNo: row.invoice_no || null,
    registerId: row.register_id,
    registerCode: row.register_code,
    registerNameAr: row.register_name_ar,
    collectionNo: row.collection_no || null,
    collectionDate: toCalendarDate(row.collection_date),
    amount: parseFloat(row.amount || '0'),
    linesCount: row.lines_count !== undefined ? Number(row.lines_count) : undefined,
    status: row.status,
    reference: row.reference || null,
    memo: row.memo || null,
    journalEntryId: row.journal_entry_id || null,
    journalEntryNo: row.journal_entry_no || null,
    postedAt: row.posted_at ? (row.posted_at instanceof Date ? row.posted_at.toISOString() : String(row.posted_at)) : null,
    postedBy: row.posted_by || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export class SalesCollectionRepository {
  async list(companyId: string, customExecutor?: DbExecutor): Promise<SalesCollection[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          c.id, c.company_id, c.customer_id, c.invoice_id, c.register_id, c.collection_no,
          c.collection_date::text as collection_date, c.amount, c.status, c.reference, c.memo, c.journal_entry_id,
          c.posted_at, c.posted_by, c.created_by, c.created_at, c.updated_at,
          cust.code as customer_code, cust.name_ar as customer_name_ar,
          inv.invoice_no as invoice_no,
          reg.code as register_code, reg.name_ar as register_name_ar,
          je.entry_no as journal_entry_no,
          GREATEST(1, (SELECT COUNT(*) FROM sales_collection_lines l WHERE l.company_id = c.company_id AND l.collection_id = c.id))::int as lines_count
        FROM sales_collections c
        INNER JOIN sales_customers cust ON cust.id = c.customer_id AND cust.company_id = c.company_id
        INNER JOIN sales_invoices inv ON inv.id = c.invoice_id AND inv.company_id = c.company_id
        INNER JOIN cash_registers reg ON reg.id = c.register_id AND reg.company_id = c.company_id
        LEFT JOIN journal_entries je ON je.id = c.journal_entry_id AND je.company_id = c.company_id
        WHERE c.company_id = $1
        ORDER BY c.created_at DESC
      `;
      const res = await executor.query<any>(sql, [companyId]);
      return res.rows.map(mapRow);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, id: string, customExecutor?: DbExecutor): Promise<SalesCollection | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          c.id, c.company_id, c.customer_id, c.invoice_id, c.register_id, c.collection_no,
          c.collection_date::text as collection_date, c.amount, c.status, c.reference, c.memo, c.journal_entry_id,
          c.posted_at, c.posted_by, c.created_by, c.created_at, c.updated_at,
          cust.code as customer_code, cust.name_ar as customer_name_ar,
          inv.invoice_no as invoice_no,
          reg.code as register_code, reg.name_ar as register_name_ar,
          je.entry_no as journal_entry_no
        FROM sales_collections c
        INNER JOIN sales_customers cust ON cust.id = c.customer_id AND cust.company_id = c.company_id
        INNER JOIN sales_invoices inv ON inv.id = c.invoice_id AND inv.company_id = c.company_id
        INNER JOIN cash_registers reg ON reg.id = c.register_id AND reg.company_id = c.company_id
        LEFT JOIN journal_entries je ON je.id = c.journal_entry_id AND je.company_id = c.company_id
        WHERE c.company_id = $1 AND c.id = $2
      `;
      const res = await executor.query<any>(sql, [companyId, id]);
      if (res.rows.length === 0) return null;
      const out = mapRow(res.rows[0]);
      out.lines = await this.loadLines(companyId, id, executor, out);
      out.linesCount = out.lines.length;
      return out;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async loadLines(companyId: string, id: string, executor: DbExecutor, header: SalesCollection): Promise<SalesCollectionLine[]> {
    const res = await executor.query<any>(
      `SELECT l.line_no, l.invoice_id, l.amount, inv.invoice_no
       FROM sales_collection_lines l
       INNER JOIN sales_invoices inv ON inv.id = l.invoice_id AND inv.company_id = l.company_id
       WHERE l.company_id = $1 AND l.collection_id = $2 ORDER BY l.line_no`,
      [companyId, id]
    );
    if (res.rows.length === 0) {
      return [{ lineNo: 1, invoiceId: header.invoiceId, invoiceNo: header.invoiceNo || null, amount: header.amount }];
    }
    return res.rows.map((x: any) => ({ lineNo: x.line_no, invoiceId: x.invoice_id, invoiceNo: x.invoice_no || null, amount: parseFloat(x.amount) }));
  }

  async findByIdForUpdate(companyId: string, id: string, executor: DbExecutor): Promise<{ id: string; status: string; amount: number } | null> {
    const sql = `
      SELECT id, status, amount
      FROM sales_collections
      WHERE company_id = $1 AND id = $2
      FOR UPDATE
    `;
    const res = await executor.query<any>(sql, [companyId, id]);
    if (res.rows.length === 0) return null;
    return {
      id: res.rows[0].id,
      status: res.rows[0].status,
      amount: parseFloat(res.rows[0].amount || '0'),
    };
  }

  async createDraft(companyId: string, input: CreateSalesCollectionInput, actorUserId?: string, customExecutor?: DbExecutor): Promise<SalesCollection> {
    const run = async (executor: DbExecutor) => {
      const lines = input.lines && input.lines.length > 0 ? input.lines : [{ invoiceId: input.invoiceId as string, amount: input.amount as number }];
      const total = Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
      const sql = `
        INSERT INTO sales_collections (
          company_id, customer_id, invoice_id, register_id, collection_date, amount, reference, memo, status, created_by
        )
        VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7, $8, 'draft', $9)
        RETURNING id
      `;
      const res = await executor.query<any>(sql, [
        companyId,
        input.customerId,
        lines[0].invoiceId,
        input.registerId,
        input.collectionDate || null,
        total,
        input.reference?.trim() || null,
        input.memo?.trim() || null,
        actorUserId || null,
      ]);
      const id = res.rows[0].id;
      const ids: string[] = [];
      const nos: number[] = [];
      const amts: number[] = [];
      lines.forEach((l, i) => { ids.push(l.invoiceId); nos.push(i + 1); amts.push(l.amount); });
      await executor.query(
        `INSERT INTO sales_collection_lines (company_id, collection_id, line_no, invoice_id, amount)
         SELECT $1, $2, n, i, a FROM unnest($3::int[], $4::uuid[], $5::numeric[]) AS t(n, i, a)`,
        [companyId, id, nos, ids, amts]
      );
      const created = await this.findById(companyId, id, executor);
      return created!;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async markPosted(
    companyId: string,
    id: string,
    collectionNo: string,
    journalEntryId: string,
    postedBy?: string,
    customExecutor?: DbExecutor
  ): Promise<void> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        UPDATE sales_collections
        SET
          status = 'posted',
          collection_no = $3,
          journal_entry_id = $4,
          posted_at = NOW(),
          posted_by = $5,
          updated_at = NOW()
        WHERE company_id = $1 AND id = $2
      `;
      await executor.query(sql, [companyId, id, collectionNo, journalEntryId, postedBy || null]);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async delete(companyId: string, id: string, customExecutor?: DbExecutor): Promise<boolean> {
    const run = async (executor: DbExecutor) => {
      const sql = `DELETE FROM sales_collections WHERE company_id = $1 AND id = $2 AND status = 'draft' RETURNING id`;
      const res = await executor.query<any>(sql, [companyId, id]);
      return res.rows.length > 0;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultSalesCollectionRepository = new SalesCollectionRepository();
