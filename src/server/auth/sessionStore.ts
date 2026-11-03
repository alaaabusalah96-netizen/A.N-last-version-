import { defaultSessionRepository, SessionRepository } from './sessionRepository.js';

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Session Store (Delegates to PostgreSQL SessionRepository — No Map fallback)
 */
export class SessionStore {
  constructor(private repo: SessionRepository = defaultSessionRepository) {}

  async createSession(userId: string): Promise<Session & { rawToken?: string }> {
    const res = await this.repo.createSession(userId);
    return {
      id: res.rawToken, // authService expects session.id to be the raw token set in cookie
      userId: res.userId,
      expiresAt: res.expiresAt,
      createdAt: new Date(),
    };
  }

  async getSession(rawToken: string): Promise<Session | null> {
    const rec = await this.repo.getSessionByToken(rawToken);
    if (!rec) return null;
    return {
      id: rawToken,
      userId: rec.userId,
      expiresAt: rec.expiresAt,
      createdAt: new Date(),
    };
  }

  async revokeSession(rawToken: string): Promise<boolean> {
    return this.repo.revokeSessionByToken(rawToken);
  }

  async revokeAllForUser(userId: string): Promise<number> {
    return this.repo.revokeAllForUser(userId);
  }

  clear(): void {
    // No-op for database-backed store
  }
}

export const defaultSessionStore = new SessionStore();
