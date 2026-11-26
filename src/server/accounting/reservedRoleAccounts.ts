import { defaultCompanySettingsRepository } from '../org/companySettingsRepository.js';

/**
 * Accounts that the system uses for a specific role (receivables, custody, inventory, suppliers, VAT...).
 * They must not be used as a cash box or a bank account: money would be mixed with that role.
 * Each reserved account carries the Arabic name of its role so errors can state the real reason.
 */
const SETTINGS_ROLES: Array<[string, string]> = [
  ['inventoryAccountId', 'المخزون'],
  ['purchasesClearingAccountId', 'المشتريات المعلقة'],
  ['custodyReceivableAccountId', 'ذمة عهد الموظفين'],
  ['accountsPayableAccountId', 'الموردين (الدائنين)'],
  ['inventoryAdjustmentAccountId', 'تسويات المخزون'],
  ['openingBalanceEquityAccountId', 'رصيد أول المدة'],
  ['cogsAccountId', 'تكلفة البضاعة المباعة'],
  ['vatPayableAccountId', 'ضريبة القيمة المضافة المستحقة'],
  ['vatInputAccountId', 'ضريبة المدخلات'],
];

const NAME_ROLES: Array<[RegExp, string]> = [
  [/(عملاء|مدينون|ذمم مدينة)/, 'العملاء والذمم المدينة'],
  [/(عهد|ذمة)/, 'ذمة عهد الموظفين'],
  [/(مخزون|بضاعة)/, 'المخزون'],
  [/(موردون|الموردين|دائنون)/, 'الموردين (الدائنين)'],
];

const CODE_ROLES: Record<string, string> = {
  '1200': 'العملاء والذمم المدينة',
  '1300': 'ذمة عهد الموظفين',
  '1400': 'المخزون',
};

export interface AccountLike {
  id: string;
  code: string;
  nameAr?: string | null;
}

export type ReservedRoleResolver = (account: AccountLike) => string | null;

export async function buildReservedRoleResolver(companyId: string, executor?: any): Promise<ReservedRoleResolver> {
  const settings: any = await defaultCompanySettingsRepository.getByCompanyId(companyId, executor);
  const byId = new Map<string, string>();
  for (const [field, label] of SETTINGS_ROLES) {
    const id = settings?.[field];
    if (id && !byId.has(id)) byId.set(id, label);
  }
  return (account) => {
    const configured = byId.get(account.id);
    if (configured) return configured;
    if (CODE_ROLES[account.code]) return CODE_ROLES[account.code];
    const name = account.nameAr || '';
    for (const [pattern, label] of NAME_ROLES) {
      if (pattern.test(name)) return label;
    }
    return null;
  };
}

export function reservedRoleMessage(account: AccountLike, role: string, target: 'bank' | 'cash'): string {
  const targetAr = target === 'bank' ? 'حساب بنكي' : 'صندوق نقدي';
  return `الحساب ${account.code} (${account.nameAr || ''}) مخصص في النظام كحساب ${role}، ولا يصلح أن يكون ${targetAr}. اختر حساب نقدية أو بنك غير مخصص لدور آخر.`;
}
