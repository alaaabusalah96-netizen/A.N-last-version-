import { describe, it, expect } from 'vitest';
import { createAccountRoleChecker, findRoleRule, GRN_MAPPING_KEY } from '../configAccountRoles.js';
import { ValidationError } from '../../http/errors.js';
import { Account } from '../../accounting/accountTypes.js';

describe('configAccountRoles — createAccountRoleChecker', () => {
  const companyId = 'c1';

  const ACCOUNTS: Record<string, Account> = {
    'inv-ok': {
      id: 'inv-ok',
      companyId,
      code: '1300',
      nameAr: 'مخزون',
      nameEn: null,
      accountType: 'asset',
      parentId: null,
      isPostable: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    'inv-head': {
      id: 'inv-head',
      companyId,
      code: '1000',
      nameAr: 'الأصول',
      nameEn: null,
      accountType: 'asset',
      parentId: null,
      isPostable: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    'inv-rev': {
      id: 'inv-rev',
      companyId,
      code: '4100',
      nameAr: 'مبيعات',
      nameEn: null,
      accountType: 'revenue',
      parentId: null,
      isPostable: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    'clr-ok': {
      id: 'clr-ok',
      companyId,
      code: '2150',
      nameAr: 'مشتريات معلقة',
      nameEn: null,
      accountType: 'liability',
      parentId: null,
      isPostable: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    'clr-off': {
      id: 'clr-off',
      companyId,
      code: '2160',
      nameAr: 'معلق قديم',
      nameEn: null,
      accountType: 'liability',
      parentId: null,
      isPostable: false,
      isActive: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };

  const lookup = async (_cid: string, accountId: string) => ACCOUNTS[accountId] || null;
  const checker = createAccountRoleChecker(GRN_MAPPING_KEY, lookup);

  it('يستخرج القواعد الصحيحة لمفتاح الإعداد والحقل', () => {
    const invRule = findRoleRule(GRN_MAPPING_KEY, 'inventory_account_id');
    expect(invRule?.allowedTypes).toEqual(['asset']);
    expect(invRule?.requirePostable).toBe(true);

    const clrRule = findRoleRule(GRN_MAPPING_KEY, 'purchases_clearing_account_id');
    expect(clrRule?.allowedTypes).toEqual(['liability']);
    expect(clrRule?.requirePostable).toBe(true);
  });

  it('يمر عند اختيار حسابات صحيحة ومطابقة للدور', async () => {
    await expect(checker(companyId, 'inventory_account_id', 'inv-ok')).resolves.not.toThrow();
    await expect(checker(companyId, 'purchases_clearing_account_id', 'clr-ok')).resolves.not.toThrow();
  });

  it('يرفض الحساب غير الموجود', async () => {
    await expect(checker(companyId, 'inventory_account_id', 'ghost')).rejects.toThrow(ValidationError);
  });

  it('يرفض الحساب غير النشط', async () => {
    await expect(checker(companyId, 'purchases_clearing_account_id', 'clr-off')).rejects.toThrow(ValidationError);
  });

  it('يرفض الحساب الرئيسي غير القابل للترحيل لـ inventory_account_id', async () => {
    await expect(checker(companyId, 'inventory_account_id', 'inv-head')).rejects.toThrow(/قابلاً للترحيل/);
  });

  it('يرفض الحساب من نوع غير مطابق (revenue لـ asset)', async () => {
    await expect(checker(companyId, 'inventory_account_id', 'inv-rev')).rejects.toThrow(/نوعه revenue/);
  });
});
