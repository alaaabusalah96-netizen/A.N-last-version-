import { Account, AccountType } from '../accounting/accountTypes.js';
import { ValidationError } from '../http/errors.js';

/**
 * مصدر واحد للحقيقة: ربط مفاتيح الإعداد بأدوار الحسابات المحاسبية.
 * القاعدة: الدور يحدد النوع المسموح + إلزامية القابلية للترحيل.
 * ممنوع أي مسار تاني (واجهة أو خدمة) يخترع قواعده بنفسه.
 */
export const GRN_MAPPING_KEY = 'accounting.grn_mapping';

export interface AccountRoleRule {
  field: string;
  labelAr: string;
  allowedTypes: readonly AccountType[];
  requirePostable: boolean;
}

export const ACCOUNT_ROLE_RULES: Readonly<Record<string, readonly AccountRoleRule[]>> = {
  [GRN_MAPPING_KEY]: [
    {
      field: 'inventory_account_id',
      labelAr: 'حساب المخزون',
      allowedTypes: ['asset'],
      requirePostable: true,
    },
    {
      field: 'purchases_clearing_account_id',
      labelAr: 'حساب المشتريات المعلّقة',
      allowedTypes: ['liability'],
      requirePostable: true,
    },
  ],
};

export function roleRulesFor(key: string): readonly AccountRoleRule[] {
  return ACCOUNT_ROLE_RULES[key] || [];
}

export function findRoleRule(key: string, field: string): AccountRoleRule | null {
  for (const rule of roleRulesFor(key)) {
    if (rule.field === field) return rule;
  }
  return null;
}

export type AccountLookup = (companyId: string, accountId: string) => Promise<Account | null>;

/**
 * ReferentialChecker مبني على قواعد الدور.
 * بياخد lookup محقون، عشان يبقى قابل للاختبار بدون قاعدة بيانات.
 */
export function createAccountRoleChecker(key: string, lookup: AccountLookup) {
  return async (companyId: string, path: string, value: string): Promise<void> => {
    const account = await lookup(companyId, value);
    if (!account) {
      throw new ValidationError(
        `${path}: الحساب المحاسبي المشار إليه غير موجود في بيانات الشركة (id=${value})`
      );
    }
    if (!account.isActive) {
      throw new ValidationError(`${path}: الحساب المحاسبي المشار إليه غير نشط (${account.code})`);
    }

    const field = path.slice(path.lastIndexOf('.') + 1);
    const rule = findRoleRule(key, field);
    if (!rule) return; // دور غير مُعرَّف => الفحص الأساسي فقط (سلوك الحزمة السابقة)

    if (rule.requirePostable && !account.isPostable) {
      throw new ValidationError(
        `${path}: ${rule.labelAr} لازم يكون حساباً قابلاً للترحيل — `
        + `الحساب ${account.code} (${account.nameAr}) حساب رئيسي/تجميعي وغير قابل للترحيل`
      );
    }

    if (!rule.allowedTypes.includes(account.accountType)) {
      throw new ValidationError(
        `${path}: ${rule.labelAr} لازم يكون من نوع (${rule.allowedTypes.join(' / ')}) — `
        + `الحساب ${account.code} (${account.nameAr}) نوعه ${account.accountType}`
      );
    }
  };
}
