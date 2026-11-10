import { defaultSupplierRepository, SupplierRepository } from './supplierRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { Supplier, CreateSupplierInput } from './purchasingTypes.js';

export class SupplierService {
  constructor(
    private supplierRepo: SupplierRepository = defaultSupplierRepository,
    private auditService: AuditService = defaultAuditService
  ) {}

  async listSuppliers(companyId: string): Promise<Supplier[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.supplierRepo.listByCompany(companyId);
  }

  async getSupplier(companyId: string, supplierId: string): Promise<Supplier> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!supplierId || typeof supplierId !== 'string') {
      throw new ValidationError('supplierId is required');
    }
    const supplier = await this.supplierRepo.findById(companyId, supplierId);
    if (!supplier) {
      throw new NotFoundError('المورد المحدد غير موجود');
    }
    return supplier;
  }

  async createSupplier(
    companyId: string,
    input: CreateSupplierInput,
    actorId?: string
  ): Promise<Supplier> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    if (!input.code || typeof input.code !== 'string' || input.code.trim().length === 0) {
      throw new ValidationError('رمز المورد مطلوب');
    }

    if (!input.nameAr || typeof input.nameAr !== 'string' || input.nameAr.trim().length === 0) {
      throw new ValidationError('اسم المورد بالعربية مطلوب');
    }

    const existing = await this.supplierRepo.findByCode(companyId, input.code);
    if (existing) {
      throw new ValidationError(`رمز المورد (${input.code.trim()}) مستخدم مسبقاً لهذه الشركة`);
    }

    const supplier = await this.supplierRepo.create(companyId, input);

    await this.auditService.record({
      actorUserId: actorId || null,
      companyId,
      action: 'SUPPLIER_CREATE',
      entityType: 'purch_supplier',
      entityId: supplier.id,
      metadata: { code: supplier.code, nameAr: supplier.nameAr },
    });

    return supplier;
  }
}

export const defaultSupplierService = new SupplierService();
