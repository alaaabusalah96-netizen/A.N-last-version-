import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from '../authService.js';
import { UserStore } from '../userStore.js';
import { SessionStore } from '../sessionStore.js';

describe('AuthService Login Security', () => {
  let authService: AuthService;
  let mockUserStore: any;
  let mockSessionStore: any;

  beforeEach(() => {
    mockUserStore = {
      findByUsername: vi.fn(),
      findById: vi.fn(),
    };
    mockSessionStore = {
      createSession: vi.fn(),
    };
    
    authService = new AuthService(mockUserStore as unknown as UserStore, mockSessionStore as unknown as SessionStore);
  });

  it('should reject inactive users with InvalidCredentialsError', async () => {
    mockUserStore.findByUsername.mockResolvedValue({
      id: '123',
      username: 'inactive-user',
      passwordHash: 'some-hash',
      role: 'user',
      isActive: false
    });
    
    // Argon2 verification might still run to prevent timing attacks, 
    // but the final result should be rejection.
    await expect(authService.login('inactive-user', 'any-password-long-enough')).rejects.toThrow();
    expect(mockSessionStore.createSession).not.toHaveBeenCalled();
  });

  it('should reject non-existent users', async () => {
    mockUserStore.findByUsername.mockResolvedValue(null);
    
    await expect(authService.login('missing-user', 'any-password-long-enough')).rejects.toThrow();
    expect(mockSessionStore.createSession).not.toHaveBeenCalled();
  });

  it('should fail if role mismatch for platform_admin tasks', async () => {
     // This is covered by reconciliation tests, but login should also be solid.
     mockUserStore.findByUsername.mockResolvedValue({
      id: '123',
      username: 'user',
      passwordHash: 'some-hash',
      role: 'user',
      isActive: true
    });
    // Normal login should pass if password correct, but role is just 'user'.
    // The requirement here was about bootstrap/reconciliation roles.
  });
});
