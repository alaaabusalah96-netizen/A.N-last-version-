import { defaultItemRepository, ItemRepository } from './itemRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultCustomFieldService, CustomFieldService } from '../customization/customFieldService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { Item, CreateItemInput } from './inventoryTypes.js';

export class ItemService {
  constructor(
    private itemRepo: ItemRepository = defaultItemRepository,
    private auditService: AuditService = defaultAuditService,
    private customFieldService: Pick<CustomFieldService, 'validateValuesAgainstDefinitions' | 'setValues'> = defaultCustomFieldService
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

    return await withTenantTransaction(companyId, async (tx) => {
      const existing = await this.itemRepo.findByCode(companyId, input.code, tx);
      if (existing) {
        throw new ValidationError(`رمز الصنف (${input.code.trim()}) مستخدم مسبقاً لهذه الشركة`);
      }

      const customValues = Array.isArray(input.customValues) ? input.customValues : [];
      await this.customFieldService.validateValuesAgainstDefinitions(
        companyId,
        'item',
        null,
        customValues,
        tx
      );

      const item = await this.itemRepo.create(companyId, input, tx);

      if (customValues.length > 0) {
        await this.customFieldService.setValues(
          companyId,
          item.id,
          customValues,
          actorId,
          'item',
          tx
        );
      }

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'ITEM_CREATE',
          entityType: 'inv_item',
          entityId: item.id,
          metadata: { code: item.code, nameAr: item.nameAr, uom: item.uom },
        },
        { executor: tx }
      );

      return item;
    });
  }
}

export const defaultItemService = new ItemService();

