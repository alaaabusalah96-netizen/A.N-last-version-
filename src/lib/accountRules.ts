export interface AccountOption {
  id: string;
  code: string;
  nameAr: string;
  isActive?: boolean;
  isPostable?: boolean;
  accountType?: string;
}

export interface AccountRoleFieldRule {
  field?: string;
  labelAr?: string;
  allowedTypes: readonly string[];
  requirePostable?: boolean;
}

/**
 * مرآة لقواعد src/server/accounting/glEventCatalog.ts و configAccountRoles.ts.
 * نسخة وحيدة في الواجهة تُستورد في كل الشاشات (ممنوع التكرار).
 * الفلترة هنا للراحة فقط؛ الحكم النهائي في الخادم.
 */
const DEFAULT_FIELD_RULES: Record<string, AccountRoleFieldRule> = {
  inventory_account_id: {
    field: 'inventory_account_id',
    labelAr: 'حساب المخزون',
    allowedTypes: ['asset'],
    requirePostable: true,
  },
  purchases_clearing_account_id: {
    field: 'purchases_clearing_account_id',
    labelAr: 'حساب المشتريات المعلّقة',
    allowedTypes: ['liability'],
    requirePostable: true,
  },
};

export function usableAccounts(
  list: AccountOption[],
  fieldOrRule: string | AccountRoleFieldRule
): AccountOption[] {
  const rule = typeof fieldOrRule === 'string' ? DEFAULT_FIELD_RULES[fieldOrRule] : fieldOrRule;
  if (!rule) return list;
  const requirePostable = rule.requirePostable !== false;
  return list.filter(
    (a) =>
      a.isActive !== false &&
      (!requirePostable || a.isPostable === true) &&
      (rule.allowedTypes.length === 0 || rule.allowedTypes.includes(String(a.accountType)))
  );
}

export function isUsable(
  accountId: string,
  list: AccountOption[],
  fieldOrRule: string | AccountRoleFieldRule
): boolean {
  if (!accountId) return true;
  return usableAccounts(list, fieldOrRule).some((a) => a.id === accountId);
}
