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
   * - Must hold an active company membership for companyId, and their role within that company
   *   must grant the requested permission.
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

    // Company-specific permission check
    if (companyId) {
      const membership = await this.membershipStore.getMembership(user.id, companyId);
      if (!membership) return false;

      const rolePerms = ROLE_PERMISSIONS[membership.role as RoleName] || [];
      return rolePerms.includes(permission);
    }

    return false;
  }
}

export const defaultRbacService = new RbacService();
