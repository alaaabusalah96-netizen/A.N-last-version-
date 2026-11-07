import { hashPassword, verifyPassword } from './passwordHash.js';
import { defaultUserStore, User, UserStore } from './userStore.js';
import { defaultSessionStore, Session, SessionStore } from './sessionStore.js';
import { InvalidCredentialsError, ValidationError } from '../http/errors.js';

export interface LoginResult {
  session: Session;
  user: Omit<User, 'passwordHash'>;
}

// Pre-computed dummy Argon2 hash for constant-time comparison when username is missing
let DUMMY_PASSWORD_HASH: string | null = null;
async function getDummyHash(): Promise<string> {
  if (!DUMMY_PASSWORD_HASH) {
    DUMMY_PASSWORD_HASH = await hashPassword('dummy_constant_time_comparison_password');
  }
  return DUMMY_PASSWORD_HASH;
}

export class AuthService {
  constructor(
    private userStore: UserStore = defaultUserStore,
    private sessionStore: SessionStore = defaultSessionStore
  ) {}

  async login(username: string, plainPassword: string): Promise<LoginResult> {
    if (!username || typeof username !== 'string' || !plainPassword || typeof plainPassword !== 'string') {
      throw new ValidationError('Username and password are required');
    }

    const normalizedUsername = username.trim().toLowerCase();

    if (normalizedUsername.length > 150 || plainPassword.length < 8 || plainPassword.length > 1024) {
      throw new InvalidCredentialsError();
    }

    const user = await this.userStore.findByUsername(normalizedUsername);

    if (!user || !user.isActive) {
      // Execute constant-time dummy password verification to prevent username enumeration via timing
      const dummyHash = await getDummyHash();
      await verifyPassword(plainPassword, dummyHash);
      throw new InvalidCredentialsError();
    }

    const isValid = await verifyPassword(plainPassword, user.passwordHash);
    if (!isValid) {
      throw new InvalidCredentialsError();
    }

    const session = await this.sessionStore.createSession(user.id);
    const { passwordHash: _, ...safeUser } = user;

    return { session, user: safeUser };
  }

  async logout(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    return await this.sessionStore.revokeSession(sessionId);
  }

  async revokeAllSessionsForUser(userId: string): Promise<number> {
    if (!userId) return 0;
    return await this.sessionStore.revokeAllForUser(userId);
  }

  async getSessionUser(sessionId: string): Promise<Omit<User, 'passwordHash'> | null> {
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) return null;

    const user = await this.userStore.findById(session.userId);
    if (!user) return null;

    const { passwordHash: _, ...safeUser } = user;
    return safeUser;
  }

  /**
   * Initializes initial platform administrator account securely from environment variables.
   * Requires password length >= 12 characters.
   */
  async bootstrapPlatformAdminFromEnv(): Promise<boolean> {
    const rawUsername = process.env.PLATFORM_ADMIN_USERNAME;
    const rawPassword = process.env.PLATFORM_ADMIN_PASSWORD;

    const hasUsername = Boolean(rawUsername && rawUsername.trim() !== '');
    const hasPassword = Boolean(rawPassword && rawPassword.trim() !== '');

    // Requirement 4: If only one administrator credential is configured, fail clearly
    if ((hasUsername && !hasPassword) || (!hasUsername && hasPassword)) {
      throw new Error('[auth] FATAL: Both PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD must be configured together for administrator bootstrap');
    }

    if (!hasUsername || !hasPassword) {
      return false; // Neither configured; bootstrap not requested
    }

    const username = rawUsername!.trim().toLowerCase();
    const password = rawPassword!;

    // Requirement 5: Minimum 12-character administrator password requirement
    if (password.length < 12) {
      throw new Error('[auth] FATAL: PLATFORM_ADMIN_PASSWORD must be at least 12 characters long');
    }

    try {
      const existing = await this.userStore.findByUsername(username);
      
      if (existing) {
        if (existing.role !== 'platform_admin') {
          throw new Error(`[auth] FATAL: Bootstrap conflict — user '${username}' already exists with role '${existing.role}', not 'platform_admin'`);
        }

        if (!existing.isActive) {
           throw new Error(`[auth] FATAL: Bootstrap failed — platform admin account '${username}' is inactive`);
        }
        
        // Self-Healing: If the existing password hash does not match the current environment secret, synchronize it
        const isMatch = await verifyPassword(password, existing.passwordHash || '');
        if (!isMatch) {
          console.log(`[auth] Reconciling password for existing platform admin '${username}'...`);
          const newHash = await hashPassword(password);
          const updated = await this.userStore.updatePasswordHash(username, newHash);
          
          if (!updated) {
            throw new Error(`[auth] FATAL: Failed to update password hash for platform admin '${username}'. Zero rows affected.`);
          }
          
          console.log(`[auth] SUCCESS: Platform admin '${username}' password reconciled.`);
        } else {
          console.log(`[auth] Platform admin '${username}' is already synchronized.`);
        }

        return true;
      }

      // Strictly comply with 'Do not create a new admin account automatically'
      console.warn(`[auth] WARNING: Platform admin account '${username}' does not exist. Automatic creation is disabled.`);
      return false;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('[auth] FATAL:')) {
        throw err;
      }
      const sanitizedMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`[auth] FATAL: Bootstrap failure for platform admin '${username}': ${sanitizedMsg}`);
    }
  }
}

export const defaultAuthService = new AuthService();
