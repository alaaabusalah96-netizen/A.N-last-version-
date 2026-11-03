import { User } from '../auth/userStore.js';
import { defaultMembershipStore, MembershipStore } from '../org/membershipStore.js';
import { PermissionCode } from './permissions.js';
import { ROLE_PERMISSIONS, RoleName } from './roles.js';

export class RbacService {
  constructor(private membershipStore: MembershipStore = defaultMembershipStore) {}

  /**
   * Evaluates if a user has a specific permission.
   *
   * Note on Platform Admin:
   * - A platform_admin possesses all platform permissions across all companies by design.
   *
   * Non-Platform Users:
   * - If companyId IS provided: user must hold an active (isActive !== false) membership
   *   in that company, and their role within that company must grant the permission.
   * - If companyId is NOT provided (e.g. listing allowed companies): user is granted access
   *   if ANY of their active company memberships grants the permission.
   */
  async hasPermission(
    user: Omit<User, 'passwordHash'>,
    permission: PermissionCode,
    companyId?: string
  ): Promise<boolean> {
    if (!user) return false;

    // Platform admins have full administrative permissions
    if (user.role === 'platform_admin') {
      const allowed = ROLE_PERMISSIONS.platform_admin;
      return allowed.includes(permission);
    }

    // Explicit companyId provided
    if (companyId) {
      const membership = await this.membershipStore.getMembership(user.id, companyId);
      if (!membership || membership.isActive === false) {
        return false;
      }

      const rolePerms = ROLE_PERMISSIONS[membership.role as RoleName] || [];
      return rolePerms.includes(permission);
    }

    // No companyId provided: check if any of the user's active memberships grants the permission
    const memberships = await this.membershipStore.listByUser(user.id);
    for (const membership of memberships) {
      if (membership.isActive === false) continue;
      const rolePerms = ROLE_PERMISSIONS[membership.role as RoleName] || [];
      if (rolePerms.includes(permission)) {
        return true;
      }
    }

    return false;
  }
}

export const defaultRbacService = new RbacService();
