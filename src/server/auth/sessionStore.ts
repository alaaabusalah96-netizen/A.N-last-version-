import crypto from 'crypto';

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * In-Memory Session Store
 * Handles cryptographically secure session tokens and expiration.
 */
export class SessionStore {
  private sessions: Map<string, Session> = new Map();

  private getTtlHours(): number {
    const parsed = parseInt(process.env.SESSION_TTL_HOURS || '12', 10);
    return isNaN(parsed) || parsed <= 0 ? 12 : parsed;
  }

  createSession(userId: string): Session {
    if (!userId) {
      throw new Error('userId is required to create a session');
    }

    const sessionId = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.getTtlHours() * 60 * 60 * 1000);

    const session: Session = {
      id: sessionId,
      userId,
      expiresAt,
      createdAt: now,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(id: string): Session | null {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;

    if (new Date() > session.expiresAt) {
      this.sessions.delete(id);
      return null;
    }

    return session;
  }

  revokeSession(id: string): boolean {
    return this.sessions.delete(id);
  }

  revokeAllForUser(userId: string): number {
    let count = 0;
    for (const [id, session] of this.sessions.entries()) {
      if (session.userId === userId) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.sessions.clear();
  }
}

export const defaultSessionStore = new SessionStore();
