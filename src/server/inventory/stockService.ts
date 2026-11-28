import { defaultStockRepository, StockRepository } from './stockRepository.js';
import { defaultWarehouseRepository, WarehouseRepository } from './warehouseRepository.js';
import { defaultItemRepository, ItemRepository } from './itemRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import {
  StockBalance,
  StockMovement,
  RecordMovementInput,
  StockAdjustmentInput,
  TransferInput,
} from './inventoryTypes.js';
import { randomUUID } from 'node:crypto';
import {
  toDecimal,
  QTY_SCALE,
  COST_SCALE,
  MONEY_SCALE,
  parseExactUnits,
  fromMinorUnits,
  mulExactUnits,
  rescaleUnits,
  unitsToSafeNumber,
} from '../lib/numeric.js';
import { defaultInventoryValuationService, InventoryValuationService } from './inventoryValuationService.js';
import { defaultCompanySettingsRepository, CompanySettingsRepository } from '../org/companySettingsRepository.js';
import { defaultAccountRepository, AccountRepository } from '../accounting/accountRepository.js';
import { defaultJournalService } from '../accounting/journalService.js';
import { assertOptionalCalendarDate, resolveCompanyToday } from '../lib/calendarDate.js';



/**
 * Collects the GL lines of many stock lines so a multi-line document can post ONE journal entry
 * (a debit and credit line per item line) instead of one entry per line.
 */
export interface StockJournalCollector {
  entryDate?: string;
  lines: Array<{ accountId: string; debit: number; credit: number; lineMemo?: string }>;
  valuationMovementIds: string[];
}

// Per-transaction memo: inside one multi-line document the same company settings, GL accounts and
// "today" are read once instead of once per line (the transaction object is the cache key).
const txMemo = new WeakMap<object, Map<string, Promise<any>>>();
function memoPerTx<T>(tx: object, key: string, load: () => Promise<T>): Promise<T> {
  let m = txMemo.get(tx);
  if (!m) { m = new Map(); txMemo.set(tx, m); }
  let v = m.get(key);
  if (!v) {
    v = load();
    m.set(key, v);
    v.catch(() => m!.delete(key));
  }
  return v as Promise<T>;
}

export class StockService {
  constructor(
    private stockRepo: StockRepository = defaultStockRepository,
    private warehouseRepo: WarehouseRepository = defaultWarehouseRepository,
    private itemRepo: ItemRepository = defaultItemRepository,
    private auditService: AuditService = defaultAuditService,
    private valuationService: InventoryValuationService = defaultInventoryValuationService,
    private settingsRepo: CompanySettingsRepository = defaultCompanySettingsRepository,
    private accountRepo: AccountRepository = defaultAccountRepository
  ) {}

  async listStockBalances(companyId: string): Promise<StockBalance[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.stockRepo.listBalancesByCompany(companyId);
  }

  async listStockMovements(companyId: string): Promise<StockMovement[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.stockRepo.listMovementsByCompany(companyId);
  }

  async listStockBalancesByItem(companyId: string, itemId: string): Promise<StockBalance[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!itemId || typeof itemId !== 'string') {
      throw new ValidationError('itemId is required');
    }
    return await this.stockRepo.listBalancesByItem(companyId, itemId);
  }

  async listStockMovementsByItem(
    companyId: string,
    itemId: string,
    filters?: {
      warehouseId?: string;
      fromDate?: string;
      toDate?: string;
      movementType?: string;
    }
  ): Promise<StockMovement[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!itemId || typeof itemId !== 'string') {
      throw new ValidationError('itemId is required');
    }
    return await this.stockRepo.listMovementsByItem(companyId, itemId, filters);
  }

  /** Post one stock journal entry now, or (with a collector) hand its lines to the document. */
  private async emitJournal(
    companyId: string,
    tx: DbExecutor,
    actorId: string | undefined,
    collector: StockJournalCollector | undefined,
    entry: { entryDate: string; memo: string; lines: Array<{ accountId: string; debit: number; credit: number; lineMemo?: string }> }
  ): Promise<{ id: string | null }> {
    if (collector) {
      collector.entryDate = collector.entryDate || entry.entryDate;
      for (const l of entry.lines) {
        collector.lines.push({ ...l, lineMemo: `${entry.memo} | ${l.lineMemo ?? ''}`.slice(0, 480) });
      }
      return { id: null };
    }
    const draft = await defaultJournalService.createDraftEntry(companyId, entry, actorId, false, tx);
    const posted = await defaultJournalService.postEntry(companyId, draft.id, actorId || '', false, tx);
    return { id: posted.id };
  }

  private async linkJournal(
    companyId: string,
    tx: DbExecutor,
    collector: StockJournalCollector | undefined,
    valuationMovementId: string,
    journalEntryId: string | null
  ): Promise<void> {
    if (journalEntryId) {
      await this.valuationService.linkValuationMovementJournal(companyId, valuationMovementId, journalEntryId, tx);
    } else if (collector) {
      collector.valuationMovementIds.push(valuationMovementId);
    }
  }

  private async processReceiptCollect(
    collector: StockJournalCollector | undefined,
    companyId: string,
    input: any,
    actorId: string | undefined,
    tx: DbExecutor
  ): Promise<void> {
    const r = await this.valuationService.processReceipt(companyId, input, actorId, tx);
    if (collector && !input.journalEntryId) collector.valuationMovementIds.push(r.movement.id);
  }


  private async resolveInventoryAccountingAccounts(
    companyId: string,
    overrideContraAccountId: string | undefined,
    tx: DbExecutor
  ): Promise<{ inventoryAccountId: string; contraAccountId: string }> {
    return await memoPerTx(tx, `gl:${companyId}:${overrideContraAccountId || ''}`, () =>
      this.resolveInventoryAccountingAccountsUncached(companyId, overrideContraAccountId, tx)
    );
  }

  private async resolveInventoryAccountingAccountsUncached(
    companyId: string,
    overrideContraAccountId: string | undefined,
    tx: DbExecutor
  ): Promise<{ inventoryAccountId: string; contraAccountId: string }> {
    const settings = await this.settingsRepo.getByCompanyId(companyId, tx);
    const invId = settings?.inventoryAccountId || null;
    const contraId = overrideContraAccountId || settings?.inventoryAdjustmentAccountId || null;

    if (!invId || !contraId) {
      throw new ValidationError(
        'MISSING_ACCOUNTING_MAPPING: لا يمكن تنفيذ حركة المخزون المالية قبل ضبط "حساب المخزون" و"حساب تسويات المخزون / المصروف" في إعدادات الشركة.'
      );
    }
    if (invId === contraId) {
      throw new ValidationError('حساب المخزون والحساب المقابل للتسوية لا يمكن أن يكونا نفس الحساب');
    }

    const invAcc = await this.accountRepo.findById(companyId, invId, tx);
    if (!invAcc || !invAcc.isActive || !invAcc.isPostable || invAcc.accountType !== 'asset') {
      throw new ValidationError('حساب المخزون المربوط في إعدادات الشركة غير نشط أو غير صالح للترحيل أو ليس حساب أصل');
    }

    const contraAcc = await this.accountRepo.findById(companyId, contraId, tx);
    if (!contraAcc || !contraAcc.isActive || !contraAcc.isPostable) {
      throw new ValidationError('حساب تسويات المخزون / المصروف المقابل غير نشط أو غير صالح للترحيل');
    }

    return { inventoryAccountId: invAcc.id, contraAccountId: contraAcc.id };
  }

  /**
   * Manual stock receipt (استلام يدوي مقيّم ومربوط بالأستاذ العام)
   * Requires approved costSource, non-zero unitCost, reason, costing profile, and GL accounts.
   */
  async receiveStock(
    companyId: string,
    input: RecordMovementInput,
    actorId?: string,
    collector?: StockJournalCollector
  ): Promise<{ balance: StockBalance; movement: StockMovement; journalEntryId: string | null; unitCost: number; totalCost: number }> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!input.warehouseId || typeof input.warehouseId !== 'string') {
      throw new ValidationError('المستودع مطلوب');
    }
    if (!input.itemId || typeof input.itemId !== 'string') {
      throw new ValidationError('الصنف/المنتج مطلوب');
    }

    const qtyUnits = parseExactUnits(input.qty, QTY_SCALE, 'qty');
    if (qtyUnits <= 0n) {
      throw new ValidationError('كمية الاستلام يجب أن تكون عدداً أكبر من الصفر');
    }

    const reason = (input.reason || input.memo || '').trim();
    if (!reason) {
      throw new ValidationError('سبب الاستلام اليدوي مطلوب');
    }

    const costSource = (input.costSource || '').trim();
    if (!costSource) {
      throw new ValidationError('مصدر التكلفة المعتمد (costSource) مطلوب للاستلام اليدوي');
    }

    if (input.unitCost === undefined || input.unitCost === null) {
      throw new ValidationError('تكلفة الوحدة مطلوبة للاستلام اليدوي ولا يُسمح بالاستلام الصفري');
    }
    const unitCostUnits = parseExactUnits(input.unitCost, COST_SCALE, 'unitCost');
    if (unitCostUnits <= 0n) {
      throw new ValidationError('تكلفة الوحدة يجب أن تكون أكبر من الصفر للاستلام اليدوي');
    }

    const totalCostUnits = mulExactUnits(qtyUnits, QTY_SCALE, unitCostUnits, COST_SCALE, COST_SCALE);
    const glAmount = unitsToSafeNumber(rescaleUnits(totalCostUnits, COST_SCALE, MONEY_SCALE), MONEY_SCALE);
    if (!(glAmount > 0)) {
      throw new ValidationError('القيمة المالية للاستلام يجب أن تكون أكبر من الصفر');
    }

    const qtyNum = unitsToSafeNumber(qtyUnits, QTY_SCALE);
    const requestedEntryDate = assertOptionalCalendarDate(input.entryDate, 'تاريخ الحركة');

    return await withTenantTransaction(companyId, async (tx) => {
      const entryDate = requestedEntryDate ?? (await memoPerTx(tx, `today:${companyId}`, () => resolveCompanyToday(companyId, tx)));
      const warehouse = await this.warehouseRepo.findById(companyId, input.warehouseId, tx);
      if (!warehouse) throw new NotFoundError('المستودع المحدد غير موجود');
      if (!warehouse.isActive) throw new ValidationError('المستودع المحدد غير نشط');

      const item = await this.itemRepo.findById(companyId, input.itemId, tx);
      if (!item) throw new NotFoundError('الصنف المحدد غير موجود');
      if (!item.isActive) throw new ValidationError('الصنف المحدد غير نشط');

      // Enforce explicit costing profile before modifying balances or posting GL
      await this.valuationService.getItemCostingMethod(companyId, input.itemId, tx);
      const gl = await this.resolveInventoryAccountingAccounts(companyId, input.expenseAccountId, tx);

      const preStock = await this.stockRepo.getBalanceForUpdate(companyId, input.warehouseId, input.itemId, tx);

      // Atomic balance increment in PostgreSQL
      const balance = await this.stockRepo.incrementBalance(
        companyId,
        input.warehouseId,
        input.itemId,
        qtyNum,
        tx
      );

      const movement = await this.stockRepo.createMovement(
        companyId,
        input.warehouseId,
        input.itemId,
        'receive',
        qtyNum,
        input.memo ? `${reason} — ${input.memo}` : reason,
        actorId,
        undefined,
        tx
      );

      const postedJe = await this.emitJournal(companyId, tx, actorId, collector, {
          entryDate,
          memo: `استلام مخزني يدوي — ${item.code} (${reason})`,
          lines: [
            { accountId: gl.inventoryAccountId, debit: glAmount, credit: 0, lineMemo: `زيادة مخزون: ${item.nameAr}` },
            { accountId: gl.contraAccountId, debit: 0, credit: glAmount, lineMemo: `مقابل استلام يدوي (${costSource})` },
          ],
        });

      await this.processReceiptCollect(collector, 
        companyId,
        {
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          qty: fromMinorUnits(qtyUnits, QTY_SCALE),
          unitCost: fromMinorUnits(unitCostUnits, COST_SCALE),
          totalCost: fromMinorUnits(totalCostUnits, COST_SCALE),
          sourceType: 'MANUAL_RECEIPT',
          sourceId: movement.id,
          journalEntryId: postedJe.id,
          movementType: 'RECEIVE',
          reason,
          costSource,
          notes: input.memo ?? null,
          stockSyncMode: 'external_verified',
          expectedPreStockQty: preStock?.qty ?? 0,
          expectedPostStockQty: balance.qty,
        },
        actorId,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'STOCK_RECEIVE',
          entityType: 'inv_stock_movement',
          entityId: movement.id,
          metadata: {
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            receivedQty: qtyNum,
            unitCost: unitsToSafeNumber(unitCostUnits, COST_SCALE),
            totalCost: unitsToSafeNumber(totalCostUnits, COST_SCALE),
            costSource,
            reason,
            journalEntryId: postedJe.id,
            newQty: balance.qty,
          },
        },
        { executor: tx }
      );

      return {
        balance,
        movement,
        journalEntryId: postedJe.id,
        unitCost: unitsToSafeNumber(unitCostUnits, COST_SCALE),
        totalCost: unitsToSafeNumber(totalCostUnits, COST_SCALE),
      };
    });
  }

  /**
   * Manual stock issue (صرف مخزني يدوي بتكلفة النظام الفعلية — FIFO أو المتوسط المتحرك)
   * STRICTLY BLOCKS INSUFFICIENT STOCK AND REQUIRES VALID COSTING PROFILE + GL ACCOUNTS.
   */
  async issueStock(
    companyId: string,
    input: RecordMovementInput,
    actorId?: string,
    collector?: StockJournalCollector
  ): Promise<{ balance: StockBalance; movement: StockMovement; journalEntryId: string | null; unitCost: number; totalCost: number }> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!input.warehouseId || typeof input.warehouseId !== 'string') {
      throw new ValidationError('المستودع مطلوب');
    }
    if (!input.itemId || typeof input.itemId !== 'string') {
      throw new ValidationError('الصنف/المنتج مطلوب');
    }

    const qtyUnits = parseExactUnits(input.qty, QTY_SCALE, 'qty');
    if (qtyUnits <= 0n) {
      throw new ValidationError('كمية الصرف يجب أن تكون عدداً أكبر من الصفر');
    }
    const qtyNum = unitsToSafeNumber(qtyUnits, QTY_SCALE);

    const reason = (input.reason || input.memo || '').trim();
    if (!reason) {
      throw new ValidationError('سبب الصرف المخزني مطلوب');
    }

    const requestedEntryDate = assertOptionalCalendarDate(input.entryDate, 'تاريخ الحركة');

    return await withTenantTransaction(companyId, async (tx) => {
      const entryDate = requestedEntryDate ?? (await memoPerTx(tx, `today:${companyId}`, () => resolveCompanyToday(companyId, tx)));
      const warehouse = await this.warehouseRepo.findById(companyId, input.warehouseId, tx);
      if (!warehouse) throw new NotFoundError('المستودع المحدد غير موجود');
      if (!warehouse.isActive) throw new ValidationError('المستودع المحدد غير نشط');

      const item = await this.itemRepo.findById(companyId, input.itemId, tx);
      if (!item) throw new NotFoundError('الصنف المحدد غير موجود');
      if (!item.isActive) throw new ValidationError('الصنف المحدد غير نشط');

      if (input.costCenterId) {
        if (!isUuid(input.costCenterId)) throw new ValidationError('مركز التكلفة غير صالح');
        const cc = await tx.query<any>(
          `SELECT unit_type as "unitType", is_active as "isActive" FROM org_units WHERE company_id = $1 AND id = $2`,
          [companyId, input.costCenterId]
        );
        if (cc.rows.length === 0) throw new NotFoundError('مركز التكلفة المحدد غير موجود');
        if (cc.rows[0].unitType !== 'cost_center') throw new ValidationError('الوحدة المحددة ليست مركز تكلفة');
        if (!cc.rows[0].isActive) throw new ValidationError('مركز التكلفة المحدد غير نشط');
      }

      await this.valuationService.getItemCostingMethod(companyId, input.itemId, tx);
      const gl = await this.resolveInventoryAccountingAccounts(companyId, input.expenseAccountId, tx);

      const preStock = await this.stockRepo.getBalanceForUpdate(companyId, input.warehouseId, input.itemId, tx);
      const preQty = toDecimal(preStock?.qty);

      // Conditional atomic decrement in PostgreSQL (ensures qty >= input.qty)
      const balance = await this.stockRepo.decrementBalance(
        companyId,
        input.warehouseId,
        input.itemId,
        qtyNum,
        tx
      );

      if (!balance) {
        const cur = await this.stockRepo.getBalanceForUpdate(companyId, input.warehouseId, input.itemId, tx);
        const currentQty = toDecimal(cur?.qty);
        // STRICT NON-NEGATIVE STOCK GUARD
        if (currentQty < input.qty) {
          throw new ValidationError(
            `رصيد غير كافٍ في المستودع للصنف (${item.code} - ${item.nameAr}). الرصيد الحالي: ${currentQty} ${item.uom}، الكمية المطلوبة للصرف: ${input.qty} ${item.uom}. لا يمكن إتمام العملية برصيد بالسالب.`
          );
        }
        throw new ValidationError('رصيد غير كافٍ لإتمام عملية الصرف');
      }

      const movement = await this.stockRepo.createMovement(
        companyId,
        input.warehouseId,
        input.itemId,
        'issue',
        qtyNum,
        input.memo ? `${reason} — ${input.memo}` : reason,
        actorId,
        undefined,
        tx
      );
      if (input.costCenterId) {
        await tx.query(
          'UPDATE inv_stock_movements SET cost_center_id = $1 WHERE company_id = $2 AND id = $3',
          [input.costCenterId, companyId, movement.id]
        );
      }

      // Never trust client unitCost — always consume server FIFO / Moving Average
      const valResult = await this.valuationService.processIssue(
        companyId,
        {
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          qty: fromMinorUnits(qtyUnits, QTY_SCALE),
          sourceType: 'MANUAL_ISSUE',
          sourceId: movement.id,
          movementType: 'ISSUE',
          reason,
          costSource: 'SYSTEM_VALUATION',
          notes: input.memo ?? null,
          stockSyncMode: 'external_verified',
          expectedPreStockQty: preQty,
        },
        actorId,
        tx
      );

      const totalCostUnits = parseExactUnits(valResult.totalCost, COST_SCALE, 'issuedTotalCost');
      const glAmount = unitsToSafeNumber(rescaleUnits(totalCostUnits, COST_SCALE, MONEY_SCALE), MONEY_SCALE);

      let postedJeId: string | null = null;
      if (glAmount > 0) {
        const postedJe = await this.emitJournal(companyId, tx, actorId, collector, {
            entryDate,
            memo: `صرف مخزني يدوي — ${item.code} (${reason})`,
            lines: [
              { accountId: gl.contraAccountId, debit: glAmount, credit: 0, lineMemo: `صرف مخزني: ${reason}` },
              { accountId: gl.inventoryAccountId, debit: 0, credit: glAmount, lineMemo: `تخفيض مخزون: ${item.nameAr}` },
            ],
          });
        postedJeId = postedJe.id;
        await this.linkJournal(companyId, tx, collector, valResult.movement.id, postedJe.id);
      }

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'STOCK_ISSUE',
          entityType: 'inv_stock_movement',
          entityId: movement.id,
          metadata: {
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            issuedQty: qtyNum,
            unitCost: valResult.unitCost,
            totalCost: valResult.totalCost,
            reason,
            journalEntryId: postedJeId,
            newQty: balance.qty,
          },
        },
        { executor: tx }
      );

      return {
        balance,
        movement,
        journalEntryId: postedJeId,
        unitCost: valResult.unitCost,
        totalCost: valResult.totalCost,
      };
    });
  }

  /**
   * Controlled Stock Adjustments, Write-Off, Damage & Internal Consumption
   * (التسويات المخزنية، الإتلاف، العجز، والاستهلاك الداخلي)
   */
  async adjustStock(
    companyId: string,
    input: StockAdjustmentInput,
    actorId?: string,
    collector?: StockJournalCollector
  ): Promise<{
    balance: StockBalance;
    movement: StockMovement;
    journalEntryId: string | null;
    unitCost: number;
    totalCost: number;
  }> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!input.warehouseId || typeof input.warehouseId !== 'string') {
      throw new ValidationError('المستودع مطلوب');
    }
    if (!input.itemId || typeof input.itemId !== 'string') {
      throw new ValidationError('الصنف/المنتج مطلوب');
    }
    if (!['adjustment', 'write_off', 'damage', 'internal_consumption'].includes(input.adjustmentType)) {
      throw new ValidationError('نوع التسوية المخزنية غير صالح');
    }
    if (!['increase', 'decrease'].includes(input.direction)) {
      throw new ValidationError('اتجاه التسوية يجب أن يكون increase أو decrease');
    }
    if (
      input.direction === 'increase' &&
      ['write_off', 'damage', 'internal_consumption'].includes(input.adjustmentType)
    ) {
      throw new ValidationError('عمليات الإتلاف والعجز والاستهلاك الداخلي لا تقبل إلا التخفيض (decrease)');
    }

    const qtyUnits = parseExactUnits(input.qty, QTY_SCALE, 'qty');
    if (qtyUnits <= 0n) {
      throw new ValidationError('الكمية يجب أن تكون أكبر من الصفر');
    }
    const qtyNum = unitsToSafeNumber(qtyUnits, QTY_SCALE);

    const reason = (input.reason || '').trim();
    if (!reason) {
      throw new ValidationError('السبب الإلزامي للتسوية المخزنية مطلوب');
    }

    let increaseUnitCostUnits = 0n;
    let increaseTotalUnits = 0n;
    if (input.direction === 'increase') {
      if (!(input.costSource || '').trim()) {
        throw new ValidationError('مصدر التكلفة المعتمد (costSource) مطلوب للتسوية بالزيادة');
      }
      if (input.unitCost === undefined || input.unitCost === null) {
        throw new ValidationError('تكلفة الوحدة مطلوبة للتسوية بالزيادة ولا يُسمح بإنشاء مخزون صفري');
      }
      increaseUnitCostUnits = parseExactUnits(input.unitCost, COST_SCALE, 'unitCost');
      if (increaseUnitCostUnits <= 0n) {
        throw new ValidationError('تكلفة الوحدة يجب أن تكون أكبر من الصفر في التسوية بالزيادة');
      }
      increaseTotalUnits = mulExactUnits(qtyUnits, QTY_SCALE, increaseUnitCostUnits, COST_SCALE, COST_SCALE);
    }

    const requestedEntryDate = assertOptionalCalendarDate(input.entryDate, 'تاريخ الحركة');
    const sourceTypeMap: Record<StockAdjustmentInput['adjustmentType'], string> = {
      adjustment: 'STOCK_ADJUSTMENT',
      write_off: 'WRITE_OFF',
      damage: 'DAMAGE',
      internal_consumption: 'INTERNAL_CONSUMPTION',
    };

    return await withTenantTransaction(companyId, async (tx) => {
      const entryDate = requestedEntryDate ?? (await memoPerTx(tx, `today:${companyId}`, () => resolveCompanyToday(companyId, tx)));
      const warehouse = await this.warehouseRepo.findById(companyId, input.warehouseId, tx);
      if (!warehouse) throw new NotFoundError('المستودع المحدد غير موجود');
      if (!warehouse.isActive) throw new ValidationError('المستودع المحدد غير نشط');

      const item = await this.itemRepo.findById(companyId, input.itemId, tx);
      if (!item) throw new NotFoundError('الصنف المحدد غير موجود');
      if (!item.isActive) throw new ValidationError('الصنف المحدد غير نشط');

      await this.valuationService.getItemCostingMethod(companyId, input.itemId, tx);
      const gl = await this.resolveInventoryAccountingAccounts(companyId, input.expenseAccountId, tx);

      const preStock = await this.stockRepo.getBalanceForUpdate(companyId, input.warehouseId, input.itemId, tx);
      const preQty = toDecimal(preStock?.qty);

      if (input.direction === 'increase') {
        const glAmount = unitsToSafeNumber(rescaleUnits(increaseTotalUnits, COST_SCALE, MONEY_SCALE), MONEY_SCALE);
        if (!(glAmount > 0)) {
          throw new ValidationError('القيمة المالية للتسوية يجب أن تكون أكبر من الصفر');
        }

        const balance = await this.stockRepo.incrementBalance(
          companyId,
          input.warehouseId,
          input.itemId,
          qtyNum,
          tx
        );

        const movement = await this.stockRepo.createMovement(
          companyId,
          input.warehouseId,
          input.itemId,
          input.adjustmentType,
          qtyNum,
          input.memo ? `${reason} — ${input.memo}` : reason,
          actorId,
          undefined,
          tx
        );

        const postedJe = await this.emitJournal(companyId, tx, actorId, collector, {
            entryDate,
            memo: `تسوية مخزنية بالزيادة — ${item.code} (${reason})`,
            lines: [
              { accountId: gl.inventoryAccountId, debit: glAmount, credit: 0, lineMemo: `تسوية زيادة مخزون: ${item.nameAr}` },
              { accountId: gl.contraAccountId, debit: 0, credit: glAmount, lineMemo: `تسوية مخزنية: ${reason}` },
            ],
          });

        await this.processReceiptCollect(collector, 
          companyId,
          {
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            qty: fromMinorUnits(qtyUnits, QTY_SCALE),
            unitCost: fromMinorUnits(increaseUnitCostUnits, COST_SCALE),
            totalCost: fromMinorUnits(increaseTotalUnits, COST_SCALE),
            sourceType: sourceTypeMap[input.adjustmentType],
            sourceId: movement.id,
            journalEntryId: postedJe.id,
            movementType: 'ADJUSTMENT',
            reason,
            costSource: input.costSource!.trim(),
            notes: input.memo ?? null,
            stockSyncMode: 'external_verified',
            expectedPreStockQty: preQty,
            expectedPostStockQty: balance.qty,
          },
          actorId,
          tx
        );

        await this.auditService.record(
          {
            actorUserId: actorId || null,
            companyId,
            action: 'STOCK_ADJUSTMENT_INCREASE',
            entityType: 'inv_stock_movement',
            entityId: movement.id,
            metadata: {
              adjustmentType: input.adjustmentType,
              warehouseId: input.warehouseId,
              itemId: input.itemId,
              qty: qtyNum,
              unitCost: unitsToSafeNumber(increaseUnitCostUnits, COST_SCALE),
              totalCost: unitsToSafeNumber(increaseTotalUnits, COST_SCALE),
              reason,
              journalEntryId: postedJe.id,
              newQty: balance.qty,
            },
          },
          { executor: tx }
        );

        return {
          balance,
          movement,
          journalEntryId: postedJe.id,
          unitCost: unitsToSafeNumber(increaseUnitCostUnits, COST_SCALE),
          totalCost: unitsToSafeNumber(increaseTotalUnits, COST_SCALE),
        };
      }

      // Decrease / Write-off / Damage / Internal consumption
      const balance = await this.stockRepo.decrementBalance(
        companyId,
        input.warehouseId,
        input.itemId,
        qtyNum,
        tx
      );
      if (!balance) {
        const cur = await this.stockRepo.getBalanceForUpdate(companyId, input.warehouseId, input.itemId, tx);
        const currentQty = toDecimal(cur?.qty);
        if (currentQty < input.qty) {
          throw new ValidationError(
            `رصيد غير كافٍ في المستودع للصنف (${item.code} - ${item.nameAr}). الرصيد الحالي: ${currentQty} ${item.uom}، المطلوب للتسوية: ${input.qty} ${item.uom}.`
          );
        }
        throw new ValidationError('رصيد غير كافٍ لإتمام التسوية المخزنية');
      }

      const movement = await this.stockRepo.createMovement(
        companyId,
        input.warehouseId,
        input.itemId,
        input.adjustmentType,
        qtyNum,
        input.memo ? `${reason} — ${input.memo}` : reason,
        actorId,
        undefined,
        tx
      );

      const valResult = await this.valuationService.processIssue(
        companyId,
        {
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          qty: fromMinorUnits(qtyUnits, QTY_SCALE),
          sourceType: sourceTypeMap[input.adjustmentType],
          sourceId: movement.id,
          movementType: 'ADJUSTMENT',
          reason,
          costSource: 'SYSTEM_VALUATION',
          notes: input.memo ?? null,
          stockSyncMode: 'external_verified',
          expectedPreStockQty: preQty,
        },
        actorId,
        tx
      );

      const totalCostUnits = parseExactUnits(valResult.totalCost, COST_SCALE, 'adjustedTotalCost');
      const glAmount = unitsToSafeNumber(rescaleUnits(totalCostUnits, COST_SCALE, MONEY_SCALE), MONEY_SCALE);

      let postedJeId: string | null = null;
      if (glAmount > 0) {
        const postedJe = await this.emitJournal(companyId, tx, actorId, collector, {
            entryDate,
            memo: `${input.adjustmentType === 'internal_consumption' ? 'استهلاك داخلي' : 'تسوية/إتلاف مخزون'} — ${item.code} (${reason})`,
            lines: [
              { accountId: gl.contraAccountId, debit: glAmount, credit: 0, lineMemo: `${sourceTypeMap[input.adjustmentType]}: ${reason}` },
              { accountId: gl.inventoryAccountId, debit: 0, credit: glAmount, lineMemo: `تخفيض مخزون: ${item.nameAr}` },
            ],
          });
        postedJeId = postedJe.id;
        await this.linkJournal(companyId, tx, collector, valResult.movement.id, postedJe.id);
      }

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'STOCK_ADJUSTMENT_DECREASE',
          entityType: 'inv_stock_movement',
          entityId: movement.id,
          metadata: {
            adjustmentType: input.adjustmentType,
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            qty: qtyNum,
            unitCost: valResult.unitCost,
            totalCost: valResult.totalCost,
            reason,
            journalEntryId: postedJeId,
            newQty: balance.qty,
          },
        },
        { executor: tx }
      );

      return {
        balance,
        movement,
        journalEntryId: postedJeId,
        unitCost: valResult.unitCost,
        totalCost: valResult.totalCost,
      };
    });
  }

  /**
   * Transfer stock (تحويل بضاعة بين مستودعين لنفس الشركة)
   * Atomic same-company warehouse transfer preserving FIFO source-layer lineage & Moving Average value.
   */
  async transfer(
    companyId: string,
    input: TransferInput,
    actorId?: string
  ): Promise<{
    transferId: string;
    sourceBalance: StockBalance;
    destBalance: StockBalance;
    movementOut: StockMovement;
    movementIn: StockMovement;
    unitCost: number;
    totalCost: number;
  }> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!input.sourceWarehouseId || typeof input.sourceWarehouseId !== 'string') {
      throw new ValidationError('مستودع المصدر مطلوب');
    }
    if (!input.destWarehouseId || typeof input.destWarehouseId !== 'string') {
      throw new ValidationError('مستودع الوجهة مطلوب');
    }
    if (!input.itemId || typeof input.itemId !== 'string') {
      throw new ValidationError('الصنف/المنتج مطلوب');
    }

    const qtyUnits = parseExactUnits(input.qty, QTY_SCALE, 'qty');
    if (qtyUnits <= 0n) {
      throw new ValidationError('كمية التحويل يجب أن تكون عدداً أكبر من الصفر');
    }
    const qtyNum = unitsToSafeNumber(qtyUnits, QTY_SCALE);

    if (input.sourceWarehouseId === input.destWarehouseId) {
      throw new ValidationError('مستودع المصدر ومستودع الوجهة هما نفس المستودع');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const sourceWh = await this.warehouseRepo.findById(companyId, input.sourceWarehouseId, tx);
      if (!sourceWh) throw new NotFoundError('مستودع المصدر المحدد غير موجود أو لا ينتمي لهذه الشركة');
      if (!sourceWh.isActive) throw new ValidationError('مستودع المصدر المحدد غير نشط');

      const destWh = await this.warehouseRepo.findById(companyId, input.destWarehouseId, tx);
      if (!destWh) throw new NotFoundError('مستودع الوجهة المحدد غير موجود أو لا ينتمي لهذه الشركة');
      if (!destWh.isActive) throw new ValidationError('مستودع الوجهة المحدد غير نشط');

      const item = await this.itemRepo.findById(companyId, input.itemId, tx);
      if (!item) throw new NotFoundError('الصنف المحدد غير موجود');
      if (!item.isActive) throw new ValidationError('الصنف المحدد غير نشط');

      await this.valuationService.getItemCostingMethod(companyId, input.itemId, tx);

      // Safely ensure balance rows exist for both warehouses before acquiring row locks
      await this.stockRepo.ensureBalanceRow(companyId, input.sourceWarehouseId, input.itemId, tx);
      await this.stockRepo.ensureBalanceRow(companyId, input.destWarehouseId, input.itemId, tx);

      // Deadlock-safe lock ordering: lock balance rows in deterministic order sorted by warehouseId
      const [firstWhId, secondWhId] = [input.sourceWarehouseId, input.destWarehouseId].sort();

      const firstLocked = await this.stockRepo.getBalanceForUpdate(companyId, firstWhId, input.itemId, tx);
      const secondLocked = await this.stockRepo.getBalanceForUpdate(companyId, secondWhId, input.itemId, tx);

      const preSourceQty = toDecimal(
        (firstWhId === input.sourceWarehouseId ? firstLocked?.qty : secondLocked?.qty) ?? 0
      );
      const preDestQty = toDecimal(
        (firstWhId === input.destWarehouseId ? firstLocked?.qty : secondLocked?.qty) ?? 0
      );

      // Conditional atomic decrement on source warehouse balance
      const sourceBalance = await this.stockRepo.decrementBalance(
        companyId,
        input.sourceWarehouseId,
        input.itemId,
        qtyNum,
        tx
      );

      if (!sourceBalance) {
        const curSource = await this.stockRepo.getBalanceForUpdate(companyId, input.sourceWarehouseId, input.itemId, tx);
        const sourceQty = toDecimal(curSource?.qty);
        // STRICT NON-NEGATIVE STOCK GUARD FOR SOURCE WAREHOUSE
        if (sourceQty < input.qty) {
          throw new ValidationError(
            `رصيد غير كافٍ في مستودع المصدر (${sourceWh.nameAr}) للصنف (${item.code} - ${item.nameAr}). الرصيد الحالي: ${sourceQty} ${item.uom}، الكمية المطلوبة للتحويل: ${input.qty} ${item.uom}.`
          );
        }
        throw new ValidationError('رصيد غير كافٍ في مستودع المصدر');
      }

      // Atomic increment on destination warehouse balance
      const destBalance = await this.stockRepo.incrementBalance(
        companyId,
        input.destWarehouseId,
        input.itemId,
        qtyNum,
        tx
      );

      const transferId = randomUUID();

      const movementOut = await this.stockRepo.createMovement(
        companyId,
        input.sourceWarehouseId,
        input.itemId,
        'transfer_out',
        qtyNum,
        input.memo || `تحويل إلى ${destWh.nameAr}`,
        actorId,
        transferId,
        tx
      );

      const movementIn = await this.stockRepo.createMovement(
        companyId,
        input.destWarehouseId,
        input.itemId,
        'transfer_in',
        qtyNum,
        input.memo || `تحويل من ${sourceWh.nameAr}`,
        actorId,
        transferId,
        tx
      );

      // Value transfer atomically preserving every FIFO source layer / Moving Average pool
      const valTransfer = await this.valuationService.processTransfer(
        companyId,
        {
          sourceWarehouseId: input.sourceWarehouseId,
          destWarehouseId: input.destWarehouseId,
          itemId: input.itemId,
          qty: fromMinorUnits(qtyUnits, QTY_SCALE),
          sourceId: transferId,
          notes: input.memo ?? null,
          stockSyncMode: 'external_verified',
          expectedPreSourceStockQty: preSourceQty,
          expectedPreDestStockQty: preDestQty,
        },
        actorId,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'INVENTORY_TRANSFER',
          entityType: 'inv_stock_movement',
          entityId: transferId,
          metadata: {
            sourceWarehouseId: input.sourceWarehouseId,
            destWarehouseId: input.destWarehouseId,
            itemId: input.itemId,
            qty: qtyNum,
            unitCost: valTransfer.unitCost,
            totalCost: valTransfer.totalCost,
          },
        },
        { executor: tx }
      );

      return {
        transferId,
        sourceBalance,
        destBalance,
        movementOut,
        movementIn,
        unitCost: valTransfer.unitCost,
        totalCost: valTransfer.totalCost,
      };
    });
  }
}

export const defaultStockService = new StockService();
