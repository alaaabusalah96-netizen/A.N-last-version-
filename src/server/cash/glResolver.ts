import { DbExecutor } from '../db/types.js';
import { defaultCompanySettingsRepository, CompanySettingsRepository } from '../org/companySettingsRepository.js';
import { defaultConfigService, ConfigService } from '../config-platform/configService.js';
import { defaultAccountRepository, AccountRepository } from '../accounting/accountRepository.js';
import { findGlEvent } from '../accounting/glEventCatalog.js';
import { GlMappingService } from '../accounting/glMappingService.js';
import { NotFoundError, ValidationError } from '../http/errors.js';

export interface ResolvedCustodyGlMapping {
  custodyReceivableAccountId: string;
  source: 'config_platform' | 'company_settings';
  versionNo: number | null;
}

export class CustodyGlResolver {
  private glMappingService: GlMappingService;

  constructor(
    private settingsRepo: CompanySettingsRepository = defaultCompanySettingsRepository,
    private configService: Pick<ConfigService, 'resolveConfig'> = defaultConfigService,
    private accountRepo: AccountRepository = defaultAccountRepository
  ) {
    this.glMappingService = new GlMappingService(this.configService, this.accountRepo);
  }

  async resolveCustodyAccount(companyId: string, tx?: DbExecutor): Promise<ResolvedCustodyGlMapping> {
    try {
      const resolved = await this.glMappingService.resolve(companyId, 'accounting.custody_mapping');
      const acct = (resolved.accounts.custody_receivable_account_id || '').trim();
      if (acct !== '') {
        return {
          custodyReceivableAccountId: acct,
          source: 'config_platform',
          versionNo: resolved.versionNo,
        };
      }
    } catch (err) {
      if (!(err instanceof NotFoundError) && !(err instanceof Error && /not found|غير موجود/i.test(err.message))) {
        throw err;
      }
    }

    const settings = await this.settingsRepo.getByCompanyId(companyId, tx);
    const fromSettings = (settings?.custodyReceivableAccountId || '').trim();
    if (!fromSettings) {
      throw new ValidationError(
        'لا يمكن صرف أو تسوية العهدة محاسبياً قبل ضبط «حساب ذمة عهد الموظفين» في الإعدادات ← الحسابات المحاسبية ← ربط عهد الموظفين.'
      );
    }

    return {
      custodyReceivableAccountId: fromSettings,
      source: 'company_settings',
      versionNo: null,
    };
  }

  async resolveAndAssertUsable(companyId: string, tx: DbExecutor): Promise<ResolvedCustodyGlMapping> {
    const resolved = await this.resolveCustodyAccount(companyId, tx);
    const def = findGlEvent('accounting.custody_mapping');
    if (!def) {
      throw new ValidationError('تعريف حدث الربط المحاسبي accounting.custody_mapping مفقود من الكتالوج');
    }
    await this.glMappingService.assertUsable(
      companyId,
      def,
      { custody_receivable_account_id: resolved.custodyReceivableAccountId },
      tx
    );
    return resolved;
  }
}

export const defaultCustodyGlResolver = new CustodyGlResolver();
