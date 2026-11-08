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
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS] | string;
