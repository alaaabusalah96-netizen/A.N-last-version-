/**
 * RBAC Permission Codes
 * Fine-grained platform and tenant permissions.
 *
 * NOTE: As new business modules (Finance, Inventory, etc.) are developed in future packages,
 * their domain-specific permission codes will be registered modularly.
 */

export const PERMISSIONS = {
  // Company / Tenant management
  COMPANY_READ: 'company:read',
  COMPANY_WRITE: 'company:write',

  // User management
  USER_READ: 'user:read',
  USER_WRITE: 'user:write',

  // Audit logs inspection
  AUDIT_READ: 'audit:read',

  // Accounting Chart of Accounts permissions
  ACCOUNTING_ACCOUNTS_READ: 'accounting.accounts.read',
  ACCOUNTING_ACCOUNTS_CREATE: 'accounting.accounts.create',
  ACCOUNTING_ACCOUNTS_SEED: 'accounting.accounts.seed',

  // Accounting Journal Entries permissions
  ACCOUNTING_JOURNALS_READ: 'accounting.journals.read',
  ACCOUNTING_JOURNALS_WRITE: 'accounting.journals.write',
  ACCOUNTING_JOURNALS_POST: 'accounting.journals.post',

  // Organizational Units permissions
  ORG_UNITS_READ: 'org:units:read',
  ORG_UNITS_WRITE: 'org:units:write',

  // Company Settings
  COMPANY_SETTINGS_READ: 'company:settings:read',
  COMPANY_SETTINGS_WRITE: 'company:settings:write',

  // Inventory Core permissions
  INVENTORY_READ: 'inventory:read',
  INVENTORY_WRITE: 'inventory:write',
  INVENTORY_MOVEMENT: 'inventory:movement',

  // Purchasing Core permissions
  PURCHASING_READ: 'purchasing:read',
  PURCHASING_WRITE: 'purchasing:write',
  PURCHASING_POST: 'purchasing:post',

  // Dynamic Roles & Permissions management
  ROLES_READ: 'roles.read',
  ROLES_WRITE: 'roles.write',

  // Cash Registers & Employee Custody (الخزينة والعهد)
  CASH_READ: 'cash:read',
  CASH_WRITE: 'cash:write',
  CUSTODY_REQUEST: 'custody:request',
  CUSTODY_APPROVE: 'custody:approve',
  CUSTODY_DISBURSE: 'custody:disburse',
  CUSTODY_SETTLE: 'custody:settle',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS] | string;

export interface PermissionCatalogItem {
  code: PermissionCode;
  labelAr: string;
  group: 'عام' | 'الشركات' | 'المستخدمون' | 'المحاسبة' | 'المخزون' | 'المشتريات' | 'المنظمة' | 'الإعدادات' | 'الأدوار' | 'الخزينة';
}

export const PERMISSION_CATALOG: PermissionCatalogItem[] = [
  // عام
  { code: PERMISSIONS.AUDIT_READ, labelAr: 'عرض سجل التدقيق', group: 'عام' },

  // الشركات
  { code: PERMISSIONS.COMPANY_READ, labelAr: 'عرض الشركات', group: 'الشركات' },
  { code: PERMISSIONS.COMPANY_WRITE, labelAr: 'تعديل بيانات الشركات (بيانات تجريبية)', group: 'الشركات' },

  // المستخدمون
  { code: PERMISSIONS.USER_READ, labelAr: 'عرض المستخدمين', group: 'المستخدمون' },
  { code: PERMISSIONS.USER_WRITE, labelAr: 'إدارة المستخدمين والعضويات', group: 'المستخدمون' },

  // المحاسبة
  { code: PERMISSIONS.ACCOUNTING_ACCOUNTS_READ, labelAr: 'عرض الدليل المحاسبي', group: 'المحاسبة' },
  { code: PERMISSIONS.ACCOUNTING_ACCOUNTS_CREATE, labelAr: 'إنشاء حسابات في الدليل', group: 'المحاسبة' },
  { code: PERMISSIONS.ACCOUNTING_ACCOUNTS_SEED, labelAr: 'تهيئة الدليل المحاسبي الافتراضي', group: 'المحاسبة' },
  { code: PERMISSIONS.ACCOUNTING_JOURNALS_READ, labelAr: 'عرض القيود اليومية والتقارير', group: 'المحاسبة' },
  { code: PERMISSIONS.ACCOUNTING_JOURNALS_WRITE, labelAr: 'إنشاء وتعديل مسودات القيود', group: 'المحاسبة' },
  { code: PERMISSIONS.ACCOUNTING_JOURNALS_POST, labelAr: 'ترحيل القيود المحاسبية', group: 'المحاسبة' },

  // المخزون
  { code: PERMISSIONS.INVENTORY_READ, labelAr: 'عرض المستودعات والأصناف والأرصدة', group: 'المخزون' },
  { code: PERMISSIONS.INVENTORY_WRITE, labelAr: 'إنشاء وتعديل المستودعات والأصناف', group: 'المخزون' },
  { code: PERMISSIONS.INVENTORY_MOVEMENT, labelAr: 'تنفيذ حركات المخزون (استلام/صرف/تحويل)', group: 'المخزون' },

  // المشتريات
  { code: PERMISSIONS.PURCHASING_READ, labelAr: 'عرض الموردين وسندات الاستلام (GRN)', group: 'المشتريات' },
  { code: PERMISSIONS.PURCHASING_WRITE, labelAr: 'إنشاء الموردين ومسودات استلام البضائع', group: 'المشتريات' },
  { code: PERMISSIONS.PURCHASING_POST, labelAr: 'ترحيل سندات استلام البضائع (GRN)', group: 'المشتريات' },

  // المنظمة
  { code: PERMISSIONS.ORG_UNITS_READ, labelAr: 'عرض الوحدات التنظيمية', group: 'المنظمة' },
  { code: PERMISSIONS.ORG_UNITS_WRITE, labelAr: 'إدارة الوحدات التنظيمية', group: 'المنظمة' },

  // الإعدادات
  { code: PERMISSIONS.COMPANY_SETTINGS_READ, labelAr: 'عرض إعدادات الشركة والتكييفات', group: 'الإعدادات' },
  { code: PERMISSIONS.COMPANY_SETTINGS_WRITE, labelAr: 'تعديل ونشر إعدادات الشركة والتكييفات', group: 'الإعدادات' },

  // الأدوار
  { code: PERMISSIONS.ROLES_READ, labelAr: 'عرض الأدوار ومصفوفة الصلاحيات', group: 'الأدوار' },
  { code: PERMISSIONS.ROLES_WRITE, labelAr: 'إنشاء وتعديل الأدوار وتعيين الصلاحيات', group: 'الأدوار' },

  // الخزينة
  { code: PERMISSIONS.CASH_READ, labelAr: 'عرض الخزائن والصناديق والأرصدة', group: 'الخزينة' },
  { code: PERMISSIONS.CASH_WRITE, labelAr: 'إنشاء وتعديل الخزائن والصناديق', group: 'الخزينة' },
  { code: PERMISSIONS.CUSTODY_REQUEST, labelAr: 'طلب عهدة نقدية', group: 'الخزينة' },
  { code: PERMISSIONS.CUSTODY_APPROVE, labelAr: 'اعتماد ورفض طلبات العهد', group: 'الخزينة' },
  { code: PERMISSIONS.CUSTODY_DISBURSE, labelAr: 'صرف العهد النقدية وترحيلها', group: 'الخزينة' },
  { code: PERMISSIONS.CUSTODY_SETTLE, labelAr: 'تسوية وإغلاق العهد النقدية', group: 'الخزينة' },
];
