import { ConfigService } from '../config-platform/configService.js';
import { defaultAccountRepository, AccountRepository } from './accountRepository.js';
import { Account } from './accountTypes.js';
import { DbExecutor } from '../db/types.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { findGlEvent, GlEventDefinition } from './glEventCatalog.js';

export interface ResolvedGlMapping {
  eventKey: string;
  accounts: Record<string, string>;
  source: 'config_platform' | 'company_settings' | 'none';
  versionNo: number | null;
}

export class GlMappingService {
  constructor(
    private configService: Pick<ConfigService, 'resolveConfig'>,
    private accountRepo: AccountRepository = defaultAccountRepository
  ) {}

  /**
   * يقرأ الإعداد الفعّال للحدث، ويرفض أي حدث غير موصول.
   * التحقق من الحسابات (وجود/نشاط/نوع/ترحيل) منفصل ومقصود:
   * بيتم في assertUsable قبل أي كتابة.
   */
  async resolve(companyId: string, eventKey: string): Promise<ResolvedGlMapping> {
    const def = findGlEvent(eventKey);
    if (!def) throw new NotFoundError(`حدث ربط محاسبي غير معروف: ${eventKey}`);
    if (def.status !== 'wired') {
      throw new ValidationError(
        `حدث «${def.labelAr}» لسه بلا مسار ترحيل محاسبي في هذه النسخة — `
        + `الإعداد غير قابل للاستخدام حتى تُنفَّذ دورة الترحيل الخاصة به`
      );
    }

    const resolved = await this.configService.resolveConfig(companyId, eventKey);
    const content = (resolved?.content ?? {}) as Record<string, unknown>;
    const accounts: Record<string, string> = {};
    for (const f of def.fields) {
      const v = content[f.field];
      if (typeof v === 'string' && v.trim() !== '') accounts[f.field] = v.trim();
    }
    return {
      eventKey,
      accounts,
      source: resolved?.source === 'company_published' ? 'config_platform' : 'none',
      versionNo: resolved?.versionNo ?? null,
    };
  }

  async assertUsable(
    companyId: string,
    def: GlEventDefinition,
    accounts: Record<string, string>,
    tx: DbExecutor
  ): Promise<void> {
    const missing = def.fields.filter((f) => !accounts[f.field]);
    if (missing.length > 0) {
      throw new ValidationError(
        `لا يمكن الترحيل: إعداد «${def.labelAr}» ناقص — `
        + missing.map((m) => m.labelAr).join(' و ') + ' غير محدد'
      );
    }
    const values = Object.values(accounts);
    if (new Set(values).size !== values.length) {
      throw new ValidationError(`لا يمكن الترحيل: إعداد «${def.labelAr}» بيعيّن نفس الحساب لأكثر من دور`);
    }
    for (const f of def.fields) {
      const acc: Account | null = await this.accountRepo.findById(companyId, accounts[f.field], tx);
      if (!acc) throw new ValidationError(`لا يمكن الترحيل: ${f.labelAr} بيشير لحساب غير موجود (${accounts[f.field]})`);
      if (!acc.isActive) throw new ValidationError(`لا يمكن الترحيل: الحساب ${acc.code} (${acc.nameAr}) غير نشط`);
      if (f.requirePostable && !acc.isPostable) {
        throw new ValidationError(`لا يمكن الترحيل: ${f.labelAr} (${acc.code}) حساب رئيسي/تجميعي وغير قابل للترحيل`);
      }
      if (!f.allowedTypes.includes(acc.accountType)) {
        throw new ValidationError(
          `لا يمكن الترحيل: ${f.labelAr} (${acc.code}) نوعه ${acc.accountType} ولازم يكون (${f.allowedTypes.join(' / ')})`
        );
      }
    }
  }
}

export const defaultGlMappingService = new GlMappingService(
  // lazy import لتجنّب دورة استيراد
  { resolveConfig: (c: string, k: string) => import('../config-platform/configService.js').then((m) => m.defaultConfigService.resolveConfig(c, k)) }
);
