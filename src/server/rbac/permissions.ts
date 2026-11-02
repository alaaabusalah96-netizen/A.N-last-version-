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
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS] | string;
