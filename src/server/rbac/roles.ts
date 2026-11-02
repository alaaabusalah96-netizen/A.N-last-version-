import { PERMISSIONS, PermissionCode } from './permissions.js';

export type RoleName = 'platform_admin' | 'company_admin' | 'company_user';

/**
 * Static mapping of roles to their default permission sets.
 */
export const ROLE_PERMISSIONS: Record<RoleName, PermissionCode[]> = {
  platform_admin: [
    PERMISSIONS.COMPANY_READ,
    PERMISSIONS.COMPANY_WRITE,
    PERMISSIONS.USER_READ,
    PERMISSIONS.USER_WRITE,
    PERMISSIONS.AUDIT_READ,
  ],
  company_admin: [
    PERMISSIONS.COMPANY_READ,
    PERMISSIONS.COMPANY_WRITE,
    PERMISSIONS.USER_READ,
    PERMISSIONS.USER_WRITE,
  ],
  company_user: [
    PERMISSIONS.COMPANY_READ,
  ],
};
