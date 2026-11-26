import { defaultWarehouseRepository, WarehouseRepository } from './warehouseRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { Warehouse, CreateWarehouseInput, UpdateWarehouseInput } from './inventoryTypes.js';

export class WarehouseService {
  constructor(
    private warehouseRepo: WarehouseRepository = defaultWarehouseRepository,
    private auditService: AuditService = defaultAuditService
  ) {}

  async listWarehouses(companyId: string): Promise<Warehouse[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.warehouseRepo.listByCompany(companyId);
  }

  async createWarehouse(
    companyId: string,
    input: CreateWarehouseInput,
    actorId?: string
  ): Promise<Warehouse> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    if (!input.code || typeof input.code !== 'string' || input.code.trim().length === 0) {
      throw new ValidationError('رمز المستودع مطلوب');
    }

    if (!input.nameAr || typeof input.nameAr !== 'string' || input.nameAr.trim().length === 0) {
      throw new ValidationError('اسم المستودع بالعربية مطلوب');
    }

    const existing = await this.warehouseRepo.findByCode(companyId, input.code);
    if (existing) {
      throw new ValidationError(`رمز المستودع (${input.code.trim()}) مستخدم مسبقاً لهذه الشركة`);
    }

    const warehouse = await this.warehouseRepo.create(companyId, input);

    await this.auditService.record({
      actorUserId: actorId || null,
      companyId,
      action: 'WAREHOUSE_CREATE',
      entityType: 'inv_warehouse',
      entityId: warehouse.id,
      metadata: { code: warehouse.code, nameAr: warehouse.nameAr },
    });

    return warehouse;
  }

  async updateWarehouse(
    companyId: string,
    id: string,
    input: UpdateWarehouseInput,
    actorId?: string
  ): Promise<Warehouse> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!id || typeof id !== 'string') {
      throw new ValidationError('المعرف مطلوب');
    }
    if (input.nameAr !== undefined && (typeof input.nameAr !== 'string' || input.nameAr.trim().length === 0)) {
      throw new ValidationError('الاسم بالعربية لا يمكن أن يكون فارغاً');
    }
    if (input.isActive !== undefined && typeof input.isActive !== 'boolean') {
      throw new ValidationError('حالة التفعيل يجب أن تكون true أو false');
    }
    const existing = await this.warehouseRepo.findById(companyId, id);
    if (!existing) {
      throw new NotFoundError('المستودع المحدد غير موجود');
    }
    if (input.isActive === false && existing.isActive) {
      const stockRes = await withTenantTransaction(companyId, async (tx) =>
        tx.query<{ qty: string }>(
          `SELECT COALESCE(SUM(qty), 0)::text AS qty FROM inv_stock_balances WHERE company_id = $1 AND warehouse_id = $2`,
          [companyId, id]
        )
      );
      if (Number(stockRes.rows[0]?.qty ?? 0) !== 0) {
        throw new ValidationError('لا يمكن تعطيل المستودع لوجود رصيد مخزون به؛ انقل الرصيد أو سوِّه أولاً');
      }
    }

    const updated = await this.warehouseRepo.update(companyId, id, input);
    if (!updated) {
      throw new NotFoundError('المستودع المحدد غير موجود');
    }
    await this.auditService.record({
      actorUserId: actorId || null,
      companyId,
      action: 'WAREHOUSE_UPDATE',
      entityType: 'inv_warehouse',
      entityId: id,
      metadata: { code: updated.code, before: { nameAr: existing.nameAr, isActive: existing.isActive }, after: { nameAr: updated.nameAr, isActive: updated.isActive } },
    });
    return updated;
  }
}

export const defaultWarehouseService = new WarehouseService();
