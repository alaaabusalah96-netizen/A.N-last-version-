import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { toDecimal } from '../lib/numeric.js';
import { toCalendarDate } from '../lib/calendarDate.js';

export interface SupplierPayment {
  id: string;
  companyId: string;
  supplierId: string;
  supplierCode?: string;
  supplierNameAr?: string;
  invoiceId: string;
  supplierInvoiceNo?: string;
  registerId: string;
  registerCode?: string;
  registerNameAr?: string;
  paymentNo?: string | null;
  paymentDate: string;
  amount: number;
  status: 'draft' | 'posted' | 'cancelled';
  reference?: string | null;
  memo?: string | null;
  journalEntryId?: string | null;
  journalEntryNo?: string | null;
  postedAt?: string | null;
  postedBy?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSupplierPaymentInput {
  supplierId: string;
  invoiceId: string;
  registerId: string;
  paymentDate?: string;
  amount: number;
  reference?: string;
  memo?: string;
}

function toIsoDate(val: unknown): string {
  return toCalendarDate(val);
}

function toIsoTimestamp(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val;
  return new Date(val as Date).toISOString();
}

function mapPayment(row: any): SupplierPayment {
  return {
    id: row.id,
    companyId: row.companyId,
    supplierId: row.supplierId,
    supplierCode: row.supplierCode ?? undefined,
    supplierNameAr: row.supplierNameAr ?? undefined,
    invoiceId: row.invoiceId,
    supplierInvoiceNo: row.supplierInvoiceNo ?? undefined,
    registerId: row.registerId,
    registerCode: row.registerCode ?? undefined,
    registerNameAr: row.registerNameAr ?? undefined,
    paymentNo: row.paymentNo ?? null,
    paymentDate: toIsoDate(row.paymentDate),
    amount: toDecimal(row.amount, 2),
    status: row.status as 'draft' | 'posted' | 'cancelled',
    reference: row.reference ?? null,
    memo: row.memo ?? null,
    journalEntryId: row.journalEntryId ?? null,
    journalEntryNo: row.journalEntryNo ?? null,
    postedAt: toIsoTimestamp(row.postedAt),
    postedBy: row.postedBy ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: toIsoTimestamp(row.createdAt) || new Date().toISOString(),
    updatedAt: toIsoTimestamp(row.updatedAt) || new Date().toISOString(),
  };
}

export class SupplierPaymentRepository {
  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<SupplierPayment[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          sp.id,
          sp.company_id as "companyId",
          sp.supplier_id as "supplierId",
          s.code as "supplierCode",
          s.name_ar as "supplierNameAr",
          sp.invoice_id as "invoiceId",
          si.supplier_invoice_no as "supplierInvoiceNo",
          sp.register_id as "registerId",
          cr.code as "registerCode",
          cr.name_ar as "registerNameAr",
          sp.payment_no as "paymentNo",
          sp.payment_date::text as "paymentDate",
          sp.amount,
          sp.status,
          sp.reference,
          sp.memo,
          sp.journal_entry_id as "journalEntryId",
          je.entry_no as "journalEntryNo",
          sp.posted_at as "postedAt",
          sp.posted_by as "postedBy",
          sp.created_by as "createdBy",
          sp.created_at as "createdAt",
          sp.updated_at as "updatedAt"
        FROM purch_supplier_payments sp
        INNER JOIN purch_suppliers s ON s.id = sp.supplier_id AND s.company_id = sp.company_id
        INNER JOIN purch_supplier_invoices si ON si.id = sp.invoice_id AND si.company_id = sp.company_id
        INNER JOIN cash_registers cr ON cr.id = sp.register_id AND cr.company_id = sp.company_id
        LEFT JOIN journal_entries je ON je.id = sp.journal_entry_id AND je.company_id = sp.company_id
        WHERE sp.company_id = $1
        ORDER BY sp.created_at DESC;
      `;
      const res = await executor.query<any>(sql, [companyId]);
      return res.rows.map(mapPayment);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, id: string, customExecutor?: DbExecutor): Promise<SupplierPayment | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          sp.id,
          sp.company_id as "companyId",
          sp.supplier_id as "supplierId",
          s.code as "supplierCode",
          s.name_ar as "supplierNameAr",
          sp.invoice_id as "invoiceId",
          si.supplier_invoice_no as "supplierInvoiceNo",
          sp.register_id as "registerId",
          cr.code as "registerCode",
          cr.name_ar as "registerNameAr",
          sp.payment_no as "paymentNo",
          sp.payment_date::text as "paymentDate",
          sp.amount,
          sp.status,
          sp.reference,
          sp.memo,
          sp.journal_entry_id as "journalEntryId",
          je.entry_no as "journalEntryNo",
          sp.posted_at as "postedAt",
          sp.posted_by as "postedBy",
          sp.created_by as "createdBy",
          sp.created_at as "createdAt",
          sp.updated_at as "updatedAt"
        FROM purch_supplier_payments sp
        INNER JOIN purch_suppliers s ON s.id = sp.supplier_id AND s.company_id = sp.company_id
        INNER JOIN purch_supplier_invoices si ON si.id = sp.invoice_id AND si.company_id = sp.company_id
        INNER JOIN cash_registers cr ON cr.id = sp.register_id AND cr.company_id = sp.company_id
        LEFT JOIN journal_entries je ON je.id = sp.journal_entry_id AND je.company_id = sp.company_id
        WHERE sp.company_id = $1 AND sp.id = $2;
      `;
      const res = await executor.query<any>(sql, [companyId, id]);
      if (res.rows.length === 0) return null;
      return mapPayment(res.rows[0]);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByIdForUpdate(companyId: string, id: string, tx: DbExecutor): Promise<SupplierPayment | null> {
    const sql = `
      SELECT
        id,
        company_id as "companyId",
        supplier_id as "supplierId",
        invoice_id as "invoiceId",
        register_id as "registerId",
        amount,
        status,
        payment_date::text as "paymentDate",
        payment_no as "paymentNo"
      FROM purch_supplier_payments
      WHERE company_id = $1 AND id = $2
      FOR UPDATE;
    `;
    const res = await tx.query<any>(sql, [companyId, id]);
    if (res.rows.length === 0) return null;
    return mapPayment(res.rows[0]);
  }

  async createDraft(
    companyId: string,
    input: CreateSupplierPaymentInput,
    actorId?: string,
    customExecutor?: DbExecutor
  ): Promise<SupplierPayment> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        INSERT INTO purch_supplier_payments (
          company_id,
          supplier_id,
          invoice_id,
          register_id,
          payment_date,
          amount,
          status,
          reference,
          memo,
          created_by
        )
        VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, 'draft', $7, $8, $9)
        RETURNING
          id,
          company_id as "companyId",
          supplier_id as "supplierId",
          invoice_id as "invoiceId",
          register_id as "registerId",
          payment_no as "paymentNo",
          payment_date::text as "paymentDate",
          amount,
          status,
          reference,
          memo,
          journal_entry_id as "journalEntryId",
          posted_at as "postedAt",
          posted_by as "postedBy",
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt";
      `;
      const res = await executor.query<any>(sql, [
        companyId,
        input.supplierId,
        input.invoiceId,
        input.registerId,
        input.paymentDate || null,
        toDecimal(input.amount, 2),
        input.reference?.trim() || null,
        input.memo?.trim() || null,
        actorId || null,
      ]);
      const row = res.rows[0];
      const full = await this.findById(companyId, row.id, executor);
      return full || mapPayment(row);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async markPosted(
    companyId: string,
    id: string,
    paymentNo: string,
    journalEntryId: string,
    actorId: string,
    tx: DbExecutor
  ): Promise<void> {
    await tx.query(
      `UPDATE purch_supplier_payments
       SET
         status = 'posted',
         payment_no = COALESCE(payment_no, $3),
         journal_entry_id = $4,
         posted_by = $5,
         posted_at = NOW(),
         updated_at = NOW()
       WHERE company_id = $1 AND id = $2;`,
      [companyId, id, paymentNo, journalEntryId, actorId]
    );
  }

  async cancelDraft(companyId: string, id: string, customExecutor?: DbExecutor): Promise<void> {
    const run = async (executor: DbExecutor) => {
      await executor.query(
        `DELETE FROM purch_supplier_payments WHERE company_id = $1 AND id = $2 AND status = 'draft'`,
        [companyId, id]
      );
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultSupplierPaymentRepository = new SupplierPaymentRepository();
