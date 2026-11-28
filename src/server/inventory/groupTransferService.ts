import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { defaultAuditService } from '../audit/auditService.js';
import { defaultStockService } from './stockService.js';
import { defaultItemRepository } from './itemRepository.js';
import { defaultWarehouseRepository } from './warehouseRepository.js';
import { defaultAccountRepository } from '../accounting/accountRepository.js';
import { defaultCompanySettingsRepository } from '../org/companySettingsRepository.js';

export const MAX_GROUP_TRANSFER_LINES = 100;

export interface ShipLineInput { itemId: string; qty: number }
export interface ShipInput {
  toCompanyId: string;
  fromWarehouseId: string;
  reference: string;
  memo?: string;
  fxRate?: number;
  entryDate?: string;
  lines: ShipLineInput[];
}
export interface ReceiveInput {
  warehouseId: string;
  entryDate?: string;
  /** Optional per-line received quantity. A line that is not listed is received in full. */
  lines?: { lineId: string; qtyReceived: number }[];
}
export interface IntercompanyAccounts { receivableAccountId: string | null; payableAccountId: string | null }

const HEADER_COLS = `t.id, t.transfer_no as "transferNo", t.group_id as "groupId", t.from_company_id as "fromCompanyId",
  t.to_company_id as "toCompanyId", t.from_warehouse_id as "fromWarehouseId", t.to_warehouse_id as "toWarehouseId",
  t.status, t.price_basis as "priceBasis", t.from_currency as "fromCurrency", t.to_currency as "toCurrency",
  t.fx_rate::float8 as "fxRate", t.reference, t.memo, t.shipped_at as "shippedAt", t.received_at as "receivedAt",
  fc.name_ar as "fromCompanyName", tc.name_ar as "toCompanyName"`;
const HEADER_FROM = `FROM group_transfers t JOIN companies fc ON fc.id = t.from_company_id JOIN companies tc ON tc.id = t.to_company_id`;

function num(v: unknown): number { return Number(v); }
function round(v: number, d: number): number { const f = 10 ** d; return Math.round((v + Number.EPSILON) * f) / f; }

/**
 * Intercompany stock transfers inside one company group.
 * Ship (sender company, one transaction): stock issue at the sender's cost, journal debit
 * intercompany receivable / credit inventory, plus the transfer rows.
 * Receive (receiver company, one transaction): stock receipt at the transferred cost (times the
 * stored rate), journal debit inventory / credit intercompany payable.
 * Between the two legs the transfer is "shipped" (goods in transit). Each leg is atomic.
 */
export class GroupTransferService {
  async getAccounts(companyId: string): Promise<IntercompanyAccounts> {
    return await withTenantTransaction(companyId, async (tx) => this.readAccounts(companyId, tx));
  }

  private async readAccounts(companyId: string, tx: DbExecutor): Promise<IntercompanyAccounts> {
    const r = await tx.query<any>(
      `SELECT receivable_account_id as "receivableAccountId", payable_account_id as "payableAccountId" FROM company_intercompany_accounts WHERE company_id = $1`,
      [companyId]
    );
    return r.rows[0] || { receivableAccountId: null, payableAccountId: null };
  }

  async setAccounts(companyId: string, input: IntercompanyAccounts, actorId: string): Promise<IntercompanyAccounts> {
    const rec = input.receivableAccountId || null;
    const pay = input.payableAccountId || null;
    if (rec && pay && rec === pay) throw new ValidationError('حساب الذمم المدينة وحساب الذمم الدائنة بين شركات المجموعة لا يمكن أن يكونا نفس الحساب');
    return await withTenantTransaction(companyId, async (tx) => {
      for (const [id, type, label] of [[rec, 'asset', 'حساب ذمم المجموعة المدينة'], [pay, 'liability', 'حساب ذمم المجموعة الدائنة']] as const) {
        if (!id) continue;
        if (!isUuid(id)) throw new ValidationError(`${label} غير صالح`);
        const acc = await defaultAccountRepository.findById(companyId, id, tx);
        if (!acc || !acc.isActive || !acc.isPostable) throw new ValidationError(`${label} غير موجود أو غير نشط أو غير صالح للترحيل`);
        if (acc.accountType !== type) throw new ValidationError(`${label} يجب أن يكون حساب ${type === 'asset' ? 'أصول' : 'التزامات'}`);
      }
      await tx.query(
        `INSERT INTO company_intercompany_accounts (company_id, receivable_account_id, payable_account_id, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (company_id) DO UPDATE SET receivable_account_id = EXCLUDED.receivable_account_id,
           payable_account_id = EXCLUDED.payable_account_id, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [companyId, rec, pay, actorId]
      );
      await defaultAuditService.record(
        { actorUserId: actorId, companyId, action: 'INTERCOMPANY_ACCOUNTS_SET', entityType: 'company_intercompany_accounts', entityId: companyId, metadata: { receivableAccountId: rec, payableAccountId: pay } },
        { executor: tx }
      );
      return { receivableAccountId: rec, payableAccountId: pay };
    });
  }

  /** Other active companies in the same active group as this company. */
  async listPartners(companyId: string): Promise<{ id: string; code: string; nameAr: string }[]> {
    return await withTenantTransaction(companyId, async (tx) => {
      const r = await tx.query<any>(
        `SELECT c.id, c.code, c.name_ar as "nameAr"
           FROM company_group_members me
           JOIN company_groups g ON g.id = me.group_id AND g.is_active = true
           JOIN company_group_members m ON m.group_id = me.group_id AND m.company_id <> me.company_id
           JOIN companies c ON c.id = m.company_id AND c.is_active = true
          WHERE me.company_id = $1 ORDER BY c.code`,
        [companyId]
      );
      return r.rows;
    });
  }

  private async currencyOf(companyId: string, tx: DbExecutor): Promise<string> {
    const s = await defaultCompanySettingsRepository.getByCompanyId(companyId, tx);
    const cur = (s?.defaultCurrencyCode || '').trim();
    if (!cur) throw new ValidationError('عملة الشركة غير مضبوطة في إعدادات الشركة');
    return cur;
  }

  async ship(fromCompanyId: string, input: ShipInput, actorId: string) {
    const reference = (input.reference || '').trim();
    if (!reference) throw new ValidationError('رقم مرجع التحويل مطلوب');
    if (!isUuid(input.toCompanyId)) throw new ValidationError('الشركة المستلمة غير صالحة');
    if (input.toCompanyId === fromCompanyId) throw new ValidationError('لا يمكن التحويل إلى نفس الشركة');
    if (!isUuid(input.fromWarehouseId)) throw new ValidationError('المستودع المرسل غير صالح');
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new ValidationError('أضف صنفًا واحدًا على الأقل للتحويل');
    if (input.lines.length > MAX_GROUP_TRANSFER_LINES) throw new ValidationError(`الحد الأقصى ${MAX_GROUP_TRANSFER_LINES} سطر في المستند الواحد`);
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (!l || !isUuid(l.itemId)) throw new ValidationError('صنف غير صالح في أحد السطور');
      if (!(Number(l.qty) > 0)) throw new ValidationError('الكمية في كل سطر يجب أن تكون أكبر من الصفر');
      if (seen.has(l.itemId)) throw new ValidationError('الصنف مكرر في السطور');
      seen.add(l.itemId);
    }

    // Sender side checks and codes (read only).
    const pre = await withTenantTransaction(fromCompanyId, async (tx) => {
      const partners = await tx.query<any>(
        `SELECT me.group_id as "groupId" FROM company_group_members me
           JOIN company_groups g ON g.id = me.group_id AND g.is_active = true
           JOIN company_group_members m ON m.group_id = me.group_id AND m.company_id = $2
          WHERE me.company_id = $1`,
        [fromCompanyId, input.toCompanyId]
      );
      if (partners.rows.length === 0) throw new ValidationError('الشركتان ليستا في نفس المجموعة النشطة');
      const wh = await defaultWarehouseRepository.findById(fromCompanyId, input.fromWarehouseId, tx);
      if (!wh || !wh.isActive) throw new ValidationError('المستودع المرسل غير موجود أو غير نشط');
      const acc = await this.readAccounts(fromCompanyId, tx);
      if (!acc.receivableAccountId) throw new ValidationError('MISSING_ACCOUNTING_MAPPING: اضبط حساب ذمم المجموعة المدينة لشركتك قبل التحويل');
      const fromCurrency = await this.currencyOf(fromCompanyId, tx);
      const codes = new Map<string, string>();
      for (const l of input.lines) {
        const it = await defaultItemRepository.findById(fromCompanyId, l.itemId, tx);
        if (!it || !it.isActive) throw new ValidationError('أحد الأصناف غير موجود أو غير نشط');
        codes.set(l.itemId, it.code);
      }
      return { groupId: partners.rows[0].groupId as string, receivableAccountId: acc.receivableAccountId, fromCurrency, codes };
    });

    // Receiver side checks: payable account, currency, and the same item code in the receiver company.
    const recv = await withTenantTransaction(input.toCompanyId, async (tx) => {
      const acc = await this.readAccounts(input.toCompanyId, tx);
      if (!acc.payableAccountId) throw new ValidationError('MISSING_ACCOUNTING_MAPPING: الشركة المستلمة لم تضبط حساب ذمم المجموعة الدائنة بعد');
      const toCurrency = await this.currencyOf(input.toCompanyId, tx);
      const map = new Map<string, string>();
      for (const [fromItemId, code] of pre.codes) {
        const it = await defaultItemRepository.findByCode(input.toCompanyId, code, tx);
        if (!it || !it.isActive) throw new ValidationError(`الصنف ${code} غير معرّف أو غير نشط في الشركة المستلمة. عرّفه بنفس الكود أولًا`);
        map.set(fromItemId, it.id);
      }
      return { toCurrency, map };
    });

    let fx = 1;
    if (pre.fromCurrency !== recv.toCurrency) {
      fx = Number(input.fxRate);
      if (!(fx > 0)) throw new ValidationError(`العملتان مختلفتان (${pre.fromCurrency} و${recv.toCurrency}). أدخل سعر التحويل صراحة`);
    } else if (input.fxRate !== undefined && input.fxRate !== null && Number(input.fxRate) !== 1) {
      throw new ValidationError('العملة واحدة في الشركتين، سعر التحويل يجب أن يكون 1');
    }

    return await withTenantTransaction(fromCompanyId, async (tx) => {
      const dup = await tx.query<any>(`SELECT 1 FROM group_transfers WHERE from_company_id = $1 AND reference = $2`, [fromCompanyId, reference]);
      if (dup.rows.length > 0) throw new ValidationError('رقم المرجع مستخدم في تحويل سابق لنفس الشركة');
      const h = await tx.query<any>(
        `INSERT INTO group_transfers (group_id, from_company_id, to_company_id, from_warehouse_id, status, price_basis,
            from_currency, to_currency, fx_rate, reference, memo, shipped_by)
         VALUES ($1,$2,$3,$4,'shipped','cost',$5,$6,$7,$8,$9,$10) RETURNING id, transfer_no as "transferNo"`,
        [pre.groupId, fromCompanyId, input.toCompanyId, input.fromWarehouseId, pre.fromCurrency, recv.toCurrency, fx, reference, input.memo || null, actorId]
      );
      const transferId: string = h.rows[0].id;
      let total = 0;
      for (const l of input.lines) {
        const issued = await defaultStockService.issueStock(
          fromCompanyId,
          {
            warehouseId: input.fromWarehouseId,
            itemId: l.itemId,
            qty: Number(l.qty),
            reason: `تحويل إلى شركة المجموعة (${reference})`,
            entryDate: input.entryDate,
            expenseAccountId: pre.receivableAccountId,
          },
          actorId
        );
        total += issued.totalCost;
        await tx.query(
          `INSERT INTO group_transfer_lines (transfer_id, from_item_id, to_item_id, item_code, qty_shipped, unit_cost, total_cost, ship_journal_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [transferId, l.itemId, recv.map.get(l.itemId), pre.codes.get(l.itemId), Number(l.qty), issued.unitCost, issued.totalCost, issued.journalEntryId]
        );
      }
      await defaultAuditService.record(
        { actorUserId: actorId, companyId: fromCompanyId, action: 'GROUP_TRANSFER_SHIP', entityType: 'group_transfer', entityId: transferId,
          metadata: { toCompanyId: input.toCompanyId, reference, lines: input.lines.length, totalCost: round(total, 4), fxRate: fx } },
        { executor: tx }
      );
      return { id: transferId, transferNo: Number(h.rows[0].transferNo), totalCost: round(total, 4), status: 'shipped' as const };
    });
  }

  async receive(toCompanyId: string, transferId: string, input: ReceiveInput, actorId: string) {
    if (!isUuid(transferId)) throw new ValidationError('معرّف التحويل غير صالح');
    if (!isUuid(input.warehouseId)) throw new ValidationError('مستودع الاستلام مطلوب');
    return await withTenantTransaction(toCompanyId, async (tx) => {
      const hr = await tx.query<any>(
        `SELECT id, status, reference, fx_rate::float8 as "fxRate" FROM group_transfers WHERE id = $1 AND to_company_id = $2 FOR UPDATE`,
        [transferId, toCompanyId]
      );
      if (hr.rows.length === 0) throw new NotFoundError('التحويل غير موجود لهذه الشركة');
      const t = hr.rows[0];
      if (t.status !== 'shipped') throw new ValidationError('تم استلام هذا التحويل بالفعل');
      const wh = await defaultWarehouseRepository.findById(toCompanyId, input.warehouseId, tx);
      if (!wh || !wh.isActive) throw new ValidationError('مستودع الاستلام غير موجود أو غير نشط');
      const acc = await this.readAccounts(toCompanyId, tx);
      if (!acc.payableAccountId) throw new ValidationError('MISSING_ACCOUNTING_MAPPING: اضبط حساب ذمم المجموعة الدائنة لشركتك قبل الاستلام');
      const lr = await tx.query<any>(
        `SELECT id, to_item_id as "toItemId", item_code as "itemCode", qty_shipped::float8 as "qtyShipped", unit_cost::float8 as "unitCost"
           FROM group_transfer_lines WHERE transfer_id = $1 ORDER BY id`,
        [transferId]
      );
      const overrides = new Map<string, number>();
      for (const o of input.lines || []) {
        if (!lr.rows.some((r: any) => r.id === o.lineId)) throw new ValidationError('سطر غير تابع لهذا التحويل');
        overrides.set(o.lineId, Number(o.qtyReceived));
      }
      let short = false;
      let total = 0;
      for (const l of lr.rows) {
        const qty = overrides.has(l.id) ? (overrides.get(l.id) as number) : l.qtyShipped;
        if (!(qty >= 0) || qty > l.qtyShipped) throw new ValidationError(`الكمية المستلمة للصنف ${l.itemCode} يجب أن تكون بين 0 والكمية المشحونة (${l.qtyShipped})`);
        if (qty < l.qtyShipped) short = true;
        const unitCost = round(l.unitCost * t.fxRate, 6);
        let jeId: string | null = null;
        if (qty > 0) {
          const rcv = await defaultStockService.receiveStock(
            toCompanyId,
            {
              warehouseId: input.warehouseId,
              itemId: l.toItemId,
              qty,
              unitCost,
              costSource: 'INTERCOMPANY_TRANSFER',
              reason: `استلام تحويل من شركة المجموعة (${t.reference})`,
              entryDate: input.entryDate,
              expenseAccountId: acc.payableAccountId,
            },
            actorId
          );
          jeId = rcv.journalEntryId;
          total += rcv.totalCost;
        }
        await tx.query(
          `UPDATE group_transfer_lines SET qty_received = $1, received_unit_cost = $2, receive_journal_id = $3 WHERE id = $4`,
          [qty, unitCost, jeId, l.id]
        );
      }
      const status = short ? 'received_short' : 'received';
      await tx.query(
        `UPDATE group_transfers SET status = $1, to_warehouse_id = $2, received_by = $3, received_at = now() WHERE id = $4`,
        [status, input.warehouseId, actorId, transferId]
      );
      await defaultAuditService.record(
        { actorUserId: actorId, companyId: toCompanyId, action: 'GROUP_TRANSFER_RECEIVE', entityType: 'group_transfer', entityId: transferId,
          metadata: { status, totalCost: round(total, 4), warehouseId: input.warehouseId } },
        { executor: tx }
      );
      return { id: transferId, status, totalCost: round(total, 4) };
    });
  }

  /** Transfers the company sent or received. */
  async list(companyId: string) {
    return await withTenantTransaction(companyId, async (tx) => {
      const r = await tx.query<any>(
        `SELECT ${HEADER_COLS},
                (SELECT count(*)::int FROM group_transfer_lines l WHERE l.transfer_id = t.id) as "lineCount",
                (SELECT COALESCE(sum(l.total_cost),0)::float8 FROM group_transfer_lines l WHERE l.transfer_id = t.id) as "totalCost"
           ${HEADER_FROM}
          WHERE t.from_company_id = $1 OR t.to_company_id = $1
          ORDER BY t.shipped_at DESC LIMIT 500`,
        [companyId]
      );
      return r.rows.map((x: any) => ({ ...x, direction: x.fromCompanyId === companyId ? 'out' : 'in' }));
    });
  }

  async get(companyId: string, transferId: string) {
    if (!isUuid(transferId)) throw new ValidationError('معرّف التحويل غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const r = await tx.query<any>(
        `SELECT ${HEADER_COLS} ${HEADER_FROM} WHERE t.id = $1 AND (t.from_company_id = $2 OR t.to_company_id = $2)`,
        [transferId, companyId]
      );
      if (r.rows.length === 0) throw new NotFoundError('التحويل غير موجود');
      const l = await tx.query<any>(
        `SELECT id, item_code as "itemCode", qty_shipped::float8 as "qtyShipped", unit_cost::float8 as "unitCost",
                total_cost::float8 as "totalCost", qty_received::float8 as "qtyReceived", received_unit_cost::float8 as "receivedUnitCost"
           FROM group_transfer_lines WHERE transfer_id = $1 ORDER BY id`,
        [transferId]
      );
      return { ...r.rows[0], direction: r.rows[0].fromCompanyId === companyId ? 'out' : 'in', lines: l.rows.map((x: any) => ({ ...x, qtyShipped: num(x.qtyShipped) })) };
    });
  }
}

export const defaultGroupTransferService = new GroupTransferService();
