import { defaultItemRepository, ItemRepository } from './itemRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { Item, CreateItemInput } from './inventoryTypes.js';

export class ItemService {
  constructor(
    private itemRepo: ItemRepository = defaultItemRepository,
    private auditService: AuditService = defaultAuditService
  ) {}

  async listItems(companyId: string): Promise<Item[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.itemRepo.listByCompany(companyId);
  }

  async getItem(companyId: string, itemId: string): Promise<Item> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!itemId || typeof itemId !== 'string') {
      throw new ValidationError('itemId is required');
    }
    const item = await this.itemRepo.findById(companyId, itemId);
    if (!item) {
      throw new NotFoundError('الصنف المحدد غير موجود');
    }
    return item;
  }

  async createItem(
    companyId: string,
    input: CreateItemInput,
    actorId?: string
  ): Promise<Item> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    if (!input.code || typeof input.code !== 'string' || input.code.trim().length === 0) {
      throw new ValidationError('رمز الصنف/المنتج مطلوب');
    }

    if (!input.nameAr || typeof input.nameAr !== 'string' || input.nameAr.trim().length === 0) {
      throw new ValidationError('اسم الصنف بالعربية مطلوب');
    }

    const existing = await this.itemRepo.findByCode(companyId, input.code);
    if (existing) {
      throw new ValidationError(`رمز الصنف (${input.code.trim()}) مستخدم مسبقاً لهذه الشركة`);
    }

    const item = await this.itemRepo.create(companyId, input);

    await this.auditService.record({
      actorUserId: actorId || null,
      companyId,
      action: 'ITEM_CREATE',
      entityType: 'inv_item',
      entityId: item.id,
      metadata: { code: item.code, nameAr: item.nameAr, uom: item.uom },
    });

    return item;
  }
}

export const defaultItemService = new ItemService();

