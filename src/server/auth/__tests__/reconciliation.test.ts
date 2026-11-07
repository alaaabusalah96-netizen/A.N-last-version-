import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from '../src/server/auth/authService.js';
import { UserStore } from '../src/server/auth/userStore.js';
import { SessionStore } from '../src/server/auth/sessionStore.js';

describe('AuthService - Platform Admin Credential Reconciliation', () => {
  let mockUserStore: any;
  let mockSessionStore: any;
  let authService: AuthService;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockUserStore = {
      findByUsername: vi.fn(),
      updatePasswordHash: vi.fn(),
      createUser: vi.fn(),
    };
    mockSessionStore = {};
    authService = new AuthService(mockUserStore, mockSessionStore);
  });

  it('should return false when reconciliation flag is disabled', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'false';
    const result = await authService.reconcilePlatformAdminPassword();
    expect(result).toBe(false);
  });

  it('should throw error when missing account during reconciliation', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'true';
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'verysecurepassword123';

    mockUserStore.findByUsername.mockResolvedValueOnce(null);

    await expect(authService.reconcilePlatformAdminPassword()).rejects.toThrow(
      'Reconciliation failed — platform admin account does not exist'
    );
  });

  it('should throw error when account is inactive or wrong role', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'true';
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'verysecurepassword123';

    mockUserStore.findByUsername.mockResolvedValueOnce({
      id: '1',
      username: 'admin',
      role: 'user',
      isActive: true,
      passwordHash: 'oldhash',
    });

    await expect(authService.reconcilePlatformAdminPassword()).rejects.toThrow(
      'Reconciliation failed — account is not an active platform_admin'
    );
  });

  it('should successfully update password hash when account is active platform_admin', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'true';
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'verysecurepassword123';

    mockUserStore.findByUsername.mockResolvedValueOnce({
      id: '1',
      username: 'admin',
      role: 'platform_admin',
      isActive: true,
      passwordHash: 'oldhash',
    });

    mockUserStore.updatePasswordHash.mockResolvedValueOnce(true);

    const result = await authService.reconcilePlatformAdminPassword();
    expect(result).toBe(true);
    expect(mockUserStore.updatePasswordHash).toHaveBeenCalledTimes(1);
    expect(mockUserStore.updatePasswordHash).toHaveBeenCalledWith('admin', expect.any(String));
  });

  it('should return false or handle when zero rows updated', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'true';
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'verysecurepassword123';

    mockUserStore.findByUsername.mockResolvedValueOnce({
      id: '1',
      username: 'admin',
      role: 'platform_admin',
      isActive: true,
      passwordHash: 'oldhash',
    });

    mockUserStore.updatePasswordHash.mockResolvedValueOnce(false);

    const result = await authService.reconcilePlatformAdminPassword();
    expect(result).toBe(false);
  });
});
