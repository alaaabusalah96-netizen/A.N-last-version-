import { ConfigRepository, defaultConfigRepository } from './configRepository.js';
import { defaultConfigValidationService, ConfigValidationService, ReferentialChecker } from './configValidationService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { ValidationError, NotFoundError, ConflictError } from '../http/errors.js';
import { defaultAccountRepository } from '../accounting/accountRepository.js';
import { createAccountRoleChecker } from './configAccountRoles.js';
import {
  ConfigDefinition,
  ConfigRegistryVersion,
  ConfigDraft,
  ResolvedConfig,
  SaveDraftInput,
  PublishDraftInput,
  RollbackInput,
} from './configTypes.js';

export type AccountCheckerFactory = (key: string, tx: DbExecutor) => ReferentialChecker;

/**
 * الـchecker الافتراضي: يرجع القواعد من configAccountRoles (مصدر واحد)
 * ويقرأ الحساب من مخزن الشركة عبر نفس المعاملة.
 */
export function defaultAccountCheckerFactory(key: string, tx: DbExecutor): ReferentialChecker {
  return createAccountRoleChecker(key, (companyId: string, accountId: string) =>
    defaultAccountRepository.findById(companyId, accountId, tx)
  );
}

export class ConfigService {
  constructor(
    private repo: ConfigRepository = defaultConfigRepository,
    private validation: ConfigValidationService = defaultConfigValidationService,
    private accountCheckerFactory: AccountCheckerFactory = defaultAccountCheckerFactory
  ) {}

  // ------------------------------------------------------------------ read side

  async listDefinitions(): Promise<ConfigDefinition[]> {
    return await this.repo.listDefinitions();
  }

  /**
   * Resolution order (03-DATA-MODEL-DRAFT.md §3, minus Wave B/C org-unit layer):
   * 1. Company Published (config_registry is_active)
   * 2. Platform Default (config_definitions.default_value)
   */
  async resolveConfig(companyId: string, key: string): Promise<ResolvedConfig> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!key || typeof key !== 'string') {
      throw new ValidationError('config key is required');
    }
    return await withTenantTransaction(companyId, async (tx) => {
      const definition = await this.repo.findDefinitionByKey(key, tx);
      if (!definition) {
        throw new NotFoundError(`تعريف الإعداد غير موجود: ${key}`);
      }
      const active = await this.repo.findActive(companyId, definition.id, tx);
      if (active) {
        return {
          key,
          definitionId: definition.id,
          source: 'company_published' as const,
          versionNo: active.versionNo,
          content: active.content,
        };
      }
      return {
        key,
        definitionId: definition.id,
        source: 'platform_default' as const,
        versionNo: null,
        content: definition.defaultValue,
      };
    });
  }

  async listActiveConfigs(companyId: string): Promise<ConfigRegistryVersion[]> {
    if (!companyId || typeof companyId !== 'string' || !companyId.trim()) {
      throw new ValidationError('companyId is required');
    }
    return await withTenantTransaction(companyId, async (tx) => {
      return await this.repo.listActiveByCompany(companyId, tx);
    });
  }

  async listVersions(companyId: string, key: string): Promise<ConfigRegistryVersion[]> {
    if (!companyId || typeof companyId !== 'string' || !companyId.trim()) {
      throw new ValidationError('companyId is required');
    }
    return await withTenantTransaction(companyId, async (tx) => {
      const definition = await this.repo.findDefinitionByKey(key, tx);
      if (!definition) {
        throw new NotFoundError(`تعريف الإعداد غير موجود: ${key}`);
      }
      return await this.repo.listVersions(companyId, definition.id, tx);
    });
  }

  // ----------------------------------------------------------------- draft side

  async getDraft(companyId: string, key: string): Promise<ConfigDraft> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await withTenantTransaction(companyId, async (tx) => {
      const definition = await this.requireDefinition(key, tx);
      const draft = await this.repo.findDraft(companyId, definition.id, tx);
      if (draft) return draft;
      // Surface the platform default as an ephemeral draft view (not persisted)
      return {
        id: '',
        companyId,
        configDefinitionId: definition.id,
        status: 'draft' as const,
        content: definition.defaultValue,
        updatedBy: null,
        updatedAt: new Date(0).toISOString(),
      };
    });
  }

  async saveDraft(companyId: string, key: string, input: SaveDraftInput, actorId: string): Promise<ConfigDraft> {
    if (!companyId || typeof companyId !== 'string' || !companyId.trim()) {
      throw new ValidationError('companyId is required');
    }
    if (!actorId || typeof actorId !== 'string') {
      throw new ValidationError('actorId is required');
    }
    if (!input || !input.content || typeof input.content !== 'object' || Array.isArray(input.content)) {
      throw new ValidationError('المحتوى مطلوب ويجب أن يكون كائن JSON صحيح');
    }
    const status = input.status === 'in_review' ? 'in_review' : 'draft';

    return await withTenantTransaction(companyId, async (tx) => {
      const definition = await this.requireDefinition(key, tx);
      // Structural validation on every save (fail fast, drafts are cheap)
      this.validation.validateAgainstSchema(input.content, definition.schema as never);
      return await this.repo.upsertDraft(companyId, definition.id, input.content, status, actorId, tx);
    });
  }

  // --------------------------------------------------------------- publish flow

  async publishDraft(companyId: string, key: string, input: PublishDraftInput, actorId: string): Promise<ConfigRegistryVersion> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!actorId || typeof actorId !== 'string') {
      throw new ValidationError('actorId is required');
    }
    if (!input || !input.changeSummary || typeof input.changeSummary !== 'string' || !input.changeSummary.trim()) {
      throw new ValidationError('ملخص التغيير (changeSummary) إلزامي قبل النشر — سجل التدقيق لا يقبل نشراً بدون سبب');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const definition = await this.requireDefinition(key, tx);
      const draft = await this.repo.findDraft(companyId, definition.id, tx);
      if (!draft) {
        throw new NotFoundError('لا توجد مسودة لهذا الإعداد — عدّل المسودة أولاً قبل النشر');
      }

      // A4 gate: structural validation
      this.validation.validateAgainstSchema(draft.content, definition.schema as never);
      // A4 gate: referential validation (accounts master data)
      await this.validation.validateReferences(
        companyId,
        draft.content,
        definition.schema as never,
        this.accountCheckerFactory(key, tx)
      );

      const versionNo = await this.repo.nextVersionNo(companyId, definition.id, tx);
      const published = await this.repo.insertPublishedVersion(
        companyId,
        definition.id,
        versionNo,
        draft.content,
        input.changeSummary.trim(),
        actorId,
        tx
      );
      await this.repo.deleteDraft(companyId, definition.id, tx);
      return published;
    });
  }

  /**
   * Rollback = publish a copy of a known good version with a NEW version_no.
   * We never un-publish (03-DATA-MODEL-DRAFT.md §2.5). The immutability trigger
   * enforces this at the database level.
   */
  async rollback(companyId: string, key: string, input: RollbackInput, actorId: string): Promise<ConfigRegistryVersion> {
    if (!actorId || typeof actorId !== 'string') {
      throw new ValidationError('actorId is required');
    }
    if (!input || !Number.isInteger(input.targetVersionNo) || input.targetVersionNo < 1) {
      throw new ValidationError('رقم الإصدار المستهدف للتراجع غير صحيح');
    }
    if (!input.changeSummary || !input.changeSummary.trim()) {
      throw new ValidationError('ملخص التغيير إلزامي عند التراجع — سجل التدقيق لا يقبل تراجعاً بدون سبب');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const definition = await this.requireDefinition(key, tx);
      const target = await this.repo.findVersionByNo(companyId, definition.id, input.targetVersionNo, tx);
      if (!target) {
        throw new NotFoundError(`الإصدار المستهدف غير موجود (v${input.targetVersionNo})`);
      }
      const active = await this.repo.findActive(companyId, definition.id, tx);
      if (active && active.versionNo === input.targetVersionNo) {
        throw new ConflictError(`الإصدار v${input.targetVersionNo} نشط بالفعل — لا حاجة للتراجع`);
      }
      const versionNo = await this.repo.nextVersionNo(companyId, definition.id, tx);
      return await this.repo.insertPublishedVersion(
        companyId,
        definition.id,
        versionNo,
        target.content,
        `${input.changeSummary.trim()} (rollback to v${input.targetVersionNo})`,
        actorId,
        tx
      );
    });
  }

  private async requireDefinition(key: string, tx: DbExecutor): Promise<ConfigDefinition> {
    const definition = await this.repo.findDefinitionByKey(key, tx);
    if (!definition) {
      throw new NotFoundError(`تعريف الإعداد غير موجود: ${key}`);
    }
    return definition;
  }
}

export const defaultConfigService = new ConfigService();
