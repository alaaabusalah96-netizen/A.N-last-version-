import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthService } from '../authService.js';
import { UserStore } from '../userStore.js';
import { SessionStore } from '../sessionStore.js';

describe('AuthService Reconciliation', () => {
  let authService: AuthService;
  let mockUserStore: any;
  let mockSessionStore: any;

  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    
    mockUserStore = {
      findByUsername: vi.fn(),
      updatePasswordHash: vi.fn(),
      createUser: vi.fn(),
      findById: vi.fn(),
    };
    mockSessionStore = {};
    
    authService = new AuthService(mockUserStore as unknown as UserStore, mockSessionStore as unknown as SessionStore);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should skip reconciliation if credentials are missing', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = '';
    process.env.PLATFORM_ADMIN_PASSWORD = '';
    
    const result = await authService.bootstrapPlatformAdminFromEnv();
    expect(result).toBe(false);
    expect(mockUserStore.findByUsername).not.toHaveBeenCalled();
  });

  it('should fail if only username is provided', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = '';
    
    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow('Both PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD must be configured');
  });

  it('should fail if password is too short', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'short';
    
    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow('must be at least 12 characters long');
  });

  it('should reconcile password if hashes mismatch', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';
    
    mockUserStore.findByUsername.mockResolvedValue({
      username: 'admin',
      role: 'platform_admin',
      isActive: true,
      passwordHash: 'old-hash'
    });
    mockUserStore.updatePasswordHash.mockResolvedValue(true);
    
    const result = await authService.bootstrapPlatformAdminFromEnv();
    expect(result).toBe(true);
    expect(mockUserStore.updatePasswordHash).toHaveBeenCalled();
  });

  it('should fail if account is inactive', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';
    
    mockUserStore.findByUsername.mockResolvedValue({
      username: 'admin',
      role: 'platform_admin',
      isActive: false,
      passwordHash: 'some-hash'
    });
    
    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow('is inactive');
  });

  it('should fail if role is not platform_admin', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';
    
    mockUserStore.findByUsername.mockResolvedValue({
      username: 'admin',
      role: 'user',
      isActive: true,
      passwordHash: 'some-hash'
    });
    
    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow('already exists with role \'user\'');
  });

  it('should fail if database update affects zero rows', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';
    
    mockUserStore.findByUsername.mockResolvedValue({
      username: 'admin',
      role: 'platform_admin',
      isActive: true,
      passwordHash: 'old-hash'
    });
    mockUserStore.updatePasswordHash.mockResolvedValue(false);
    
    await expect(authService.bootstrapPlatformAdminFromEnv()).rejects.toThrow('Zero rows affected');
  });

  it('should NOT create a new admin if it does not exist', async () => {
    process.env.PLATFORM_ADMIN_USERNAME = 'admin';
    process.env.PLATFORM_ADMIN_PASSWORD = 'very-long-secure-password';
    
    mockUserStore.findByUsername.mockResolvedValue(null);
    
    const result = await authService.bootstrapPlatformAdminFromEnv();
    expect(result).toBe(false);
    expect(mockUserStore.createUser).not.toHaveBeenCalled();
  });
});
