import { CustomerRepository, defaultCustomerRepository } from './customerRepository.js';
import { Customer, CreateCustomerInput, UpdateCustomerInput } from './salesTypes.js';
import { ValidationError, NotFoundError, ConflictError } from '../http/errors.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';

export class CustomerService {
  constructor(
    private customerRepo: CustomerRepository = defaultCustomerRepository,
    private auditService: AuditService = defaultAuditService
  ) {}

  async listCustomers(companyId: string): Promise<Customer[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.customerRepo.list(companyId);
  }

  async getCustomer(companyId: string, id: string): Promise<Customer> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');
    const customer = await this.customerRepo.findById(companyId, id);
    if (!customer) throw new NotFoundError('العميل غير موجود');
    return customer;
  }

  async createCustomer(companyId: string, input: CreateCustomerInput, actorUserId?: string): Promise<Customer> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!input.code || input.code.trim() === '') {
      throw new ValidationError('كود العميل مطلوب');
    }
    if (!input.nameAr || input.nameAr.trim() === '') {
      throw new ValidationError('اسم العميل بالعربية مطلوب');
    }

    const normalizedCode = input.code.trim().toUpperCase();
    const existing = await this.customerRepo.findByCode(companyId, normalizedCode);
    if (existing) {
      throw new ConflictError(`كود العميل '${normalizedCode}' مستخدم بالفعل في هذه الشركة`);
    }

    const customer = await this.customerRepo.create(companyId, {
      ...input,
      code: normalizedCode,
    });

    await this.auditService.record({
      actorUserId: actorUserId || null,
      companyId,
      action: 'SALES_CUSTOMER_CREATE',
      entityType: 'sales_customers',
      entityId: customer.id,
      metadata: { code: customer.code, nameAr: customer.nameAr },
    });

    return customer;
  }

  async updateCustomer(companyId: string, id: string, input: UpdateCustomerInput, actorUserId?: string): Promise<Customer> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');

    const updated = await this.customerRepo.update(companyId, id, input);
    if (!updated) throw new NotFoundError('العميل غير موجود');

    await this.auditService.record({
      actorUserId: actorUserId || null,
      companyId,
      action: 'SALES_CUSTOMER_UPDATE',
      entityType: 'sales_customers',
      entityId: updated.id,
      metadata: { nameAr: updated.nameAr },
    });

    return updated;
  }

  async deleteCustomer(companyId: string, id: string, actorUserId?: string): Promise<boolean> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');

    const success = await this.customerRepo.delete(companyId, id);
    if (!success) throw new NotFoundError('العميل غير موجود أو مرتبط بعمليات مبيعات');

    await this.auditService.record({
      actorUserId: actorUserId || null,
      companyId,
      action: 'SALES_CUSTOMER_DELETE',
      entityType: 'sales_customers',
      entityId: id,
    });

    return true;
  }
}

export const defaultCustomerService = new CustomerService();
