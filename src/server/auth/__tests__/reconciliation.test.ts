import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthService } from '../authService.js';

describe('AuthService - Platform Admin Credential Reconciliation', () => {
  let mockUserStore: any;
  let mockSessionStore: any;
  let authService: AuthService;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    mockUserStore = {
      findByUsername: vi.fn(),
      updatePasswordHash: vi.fn(),
    };
    mockSessionStore = {};
    authService = new AuthService(mockUserStore, mockSessionStore);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should return undefined when reconciliation flag is disabled', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'false';
    const result = await authService.reconcilePlatformAdminPassword();
    expect(result).toBeUndefined();
    expect(mockUserStore.findByUsername).not.toHaveBeenCalled();
  });

  it('should throw error when missing credentials while enabled', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'true';
    process.env.PLATFORM_ADMIN_USERNAME = '';
    process.env.PLATFORM_ADMIN_PASSWORD = '';

    await expect(authService.reconcilePlatformAdminPassword()).rejects.toThrow(
      'Reconciliation failed — PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD must be configured'
    );
  });

  it('should throw error when missing account', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'true';
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'verysecurepassword123';
    mockUserStore.findByUsername.mockResolvedValueOnce(null);

    await expect(authService.reconcilePlatformAdminPassword()).rejects.toThrow(
      'Reconciliation failed — platform admin account does not exist'
    );
  });

  it('should throw error when account is inactive', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'true';
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'verysecurepassword123';
    mockUserStore.findByUsername.mockResolvedValueOnce({ role: 'platform_admin', isActive: false });

    await expect(authService.reconcilePlatformAdminPassword()).rejects.toThrow(
      'Reconciliation failed — account is not an active platform_admin'
    );
  });

  it('should throw error when wrong role', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'true';
    process.env.PLATFORM_ADMIN_USERNAME = 'user';
    process.env.PLATFORM_ADMIN_PASSWORD = 'verysecurepassword123';
    mockUserStore.findByUsername.mockResolvedValueOnce({ role: 'user', isActive: true });

    await expect(authService.reconcilePlatformAdminPassword()).rejects.toThrow(
      'Reconciliation failed — account is not an active platform_admin'
    );
  });

  it('should successfully update password hash', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'true';
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'verysecurepassword123';
    mockUserStore.findByUsername.mockResolvedValueOnce({ role: 'platform_admin', isActive: true });
    mockUserStore.updatePasswordHash.mockResolvedValueOnce(true);

    await authService.reconcilePlatformAdminPassword();
    expect(mockUserStore.updatePasswordHash).toHaveBeenCalledTimes(1);
  });

  it('should throw error when zero rows updated', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'true';
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'verysecurepassword123';
    mockUserStore.findByUsername.mockResolvedValueOnce({ role: 'platform_admin', isActive: true });
    mockUserStore.updatePasswordHash.mockResolvedValueOnce(false);

    await expect(authService.reconcilePlatformAdminPassword()).rejects.toThrow(
      'Reconciliation failed — password update affected zero rows'
    );
  });

  it('should throw error on database update failure', async () => {
    process.env.PLATFORM_ADMIN_CREDENTIALS_RECONCILE = 'true';
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'verysecurepassword123';
    mockUserStore.findByUsername.mockResolvedValueOnce({ role: 'platform_admin', isActive: true });
    mockUserStore.updatePasswordHash.mockRejectedValueOnce(new Error('DB_FAILURE'));

    await expect(authService.reconcilePlatformAdminPassword()).rejects.toThrow('DB_FAILURE');
  });
});
