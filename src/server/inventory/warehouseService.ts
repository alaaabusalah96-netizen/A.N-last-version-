import { defaultWarehouseRepository, WarehouseRepository } from './warehouseRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { Warehouse, CreateWarehouseInput } from './inventoryTypes.js';

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
}

export const defaultWarehouseService = new WarehouseService();
