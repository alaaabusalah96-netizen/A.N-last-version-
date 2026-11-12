import { Account, AccountType } from '../accounting/accountTypes.js';
import { GL_EVENT_CATALOG } from '../accounting/glEventCatalog.js';
import { ValidationError } from '../http/errors.js';

/**
 * مصدر واحد للحقيقة: ربط مفاتيح الإعداد بأدوار الحسابات المحاسبية.
 * القواعد متولّدة تلقائياً من GL_EVENT_CATALOG — أي حدث موصول في الكتالوج
 * يدخل هنا بدون تكرار يدوي.
 */
export const GRN_MAPPING_KEY = 'accounting.grn_mapping';

export interface AccountRoleRule {
  field: string;
  labelAr: string;
  allowedTypes: readonly AccountType[];
  requirePostable: boolean;
}

function buildAccountRoleRules(): Readonly<Record<string, readonly AccountRoleRule[]>> {
  const rules: Record<string, readonly AccountRoleRule[]> = {};
  for (const ev of GL_EVENT_CATALOG) {
    if (ev.fields.length > 0) {
      rules[ev.eventKey] = ev.fields.map((f) => ({
        field: f.field,
        labelAr: f.labelAr,
        allowedTypes: f.allowedTypes,
        requirePostable: f.requirePostable,
      }));
    }
  }
  return rules;
}

export const ACCOUNT_ROLE_RULES: Readonly<Record<string, readonly AccountRoleRule[]>> = buildAccountRoleRules();

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

export interface CrossFieldRule {
  fields: string[];
  check: (content: Record<string, unknown>, isPublish?: boolean) => string | null; // نص الخطأ أو null
}

function buildCrossFieldRules(): Readonly<Record<string, readonly CrossFieldRule[]>> {
  const rules: Record<string, readonly CrossFieldRule[]> = {};
  for (const ev of GL_EVENT_CATALOG) {
    if (ev.fields.length < 2) continue;
    const fieldDefs = ev.fields;
    const fields = fieldDefs.map((f) => f.field);
    rules[ev.eventKey] = [
      {
        fields,
        check: (c, isPublish = true) => {
          const vals = fieldDefs.map((f) => ({
            field: f.field,
            labelAr: f.labelAr,
            val: String(c[f.field] ?? '').trim(),
          }));
          const nonEmpty = vals.filter((v) => v.val !== '');
          const uniqueNonEmpty = new Set(nonEmpty.map((v) => v.val));
          if (uniqueNonEmpty.size !== nonEmpty.length) {
            if (ev.eventKey === GRN_MAPPING_KEY) {
              return 'غير مسموح: حساب المخزون وحساب المشتريات المعلّقة لا يمكن أن يكونا نفس الحساب';
            }
            return `غير مسموح: إعداد «${ev.labelAr}» يعيّن نفس الحساب لأكثر من دور`;
          }
          if (isPublish && nonEmpty.length !== vals.length) {
            if (ev.eventKey === GRN_MAPPING_KEY) {
              return 'الإعداد غير مكتمل: لازم تحدد حساب المخزون وحساب المشتريات المعلّقة قبل النشر';
            }
            const missingLabels = vals.filter((v) => v.val === '').map((v) => v.labelAr).join(' و ');
            return `الإعداد غير مكتمل: لازم تحدد ${missingLabels} قبل النشر`;
          }
          return null;
        },
      },
    ];
  }
  return rules;
}

export const CROSS_FIELD_RULES: Readonly<Record<string, readonly CrossFieldRule[]>> = buildCrossFieldRules();

export function validateCrossField(key: string, content: unknown, isPublish = true): void {
  const rules = CROSS_FIELD_RULES[key] || [];
  if (rules.length === 0) return;
  const obj = (content && typeof content === 'object' && !Array.isArray(content))
    ? content as Record<string, unknown> : {};

  for (const rule of rules) {
    const errMsg = rule.check(obj, isPublish);
    if (errMsg) {
      throw new ValidationError(errMsg);
    }
  }
}
