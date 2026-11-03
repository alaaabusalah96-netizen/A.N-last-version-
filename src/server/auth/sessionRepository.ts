import crypto from 'crypto';
import { getDefaultExecutor } from '../db/index.js';

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export class SessionRepository {
  private async getExecutor() {
    const executor = await getDefaultExecutor();
    if (!executor) {
      throw new Error('DB_UNAVAILABLE: Database executor not available for SessionRepository');
    }
    return executor;
  }

  private hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  private getTtlHours(): number {
    const parsed = parseInt(process.env.SESSION_TTL_HOURS || '12', 10);
    return isNaN(parsed) || parsed <= 0 ? 12 : parsed;
  }

  async createSession(userId: string): Promise<{ id: string; userId: string; rawToken: string; expiresAt: Date }> {
    const executor = await this.getExecutor();
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);

    const now = new Date();
    const ttlHours = this.getTtlHours();
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

    const sql = `
      INSERT INTO user_sessions (user_id, token_hash, expires_at)
      VALUES ($1, $2, $3)
      RETURNING id, user_id as "userId", expires_at as "expiresAt", created_at as "createdAt";
    `;

    const res = await executor.query<{ id: string; userId: string; expiresAt: Date }>(sql, [
      userId,
      tokenHash,
      expiresAt,
    ]);

    return {
      id: res.rows[0].id,
      userId,
      rawToken,
      expiresAt: new Date(res.rows[0].expiresAt),
    };
  }

  async getSessionByToken(rawToken: string): Promise<{ id: string; userId: string; expiresAt: Date } | null> {
    if (!rawToken) return null;
    const executor = await this.getExecutor();
    const tokenHash = this.hashToken(rawToken);

    const sql = `
      SELECT id, user_id as "userId", expires_at as "expiresAt"
      FROM user_sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW();
    `;

    const res = await executor.query<{ id: string; userId: string; expiresAt: Date }>(sql, [tokenHash]);
    if (!res.rows[0]) return null;

    return {
      id: res.rows[0].id,
      userId: res.rows[0].userId,
      expiresAt: new Date(res.rows[0].expiresAt),
    };
  }

  async revokeSessionByToken(rawToken: string): Promise<boolean> {
    if (!rawToken) return false;
    const executor = await this.getExecutor();
    const tokenHash = this.hashToken(rawToken);

    const sql = `
      UPDATE user_sessions
      SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL;
    `;

    const res = await executor.query(sql, [tokenHash]);
    return (res.rowCount ?? 0) > 0;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const executor = await this.getExecutor();
    const sql = `
      UPDATE user_sessions
      SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL;
    `;

    const res = await executor.query(sql, [userId]);
    return res.rowCount ?? 0;
  }

  async purgeExpired(): Promise<number> {
    try {
      const executor = await this.getExecutor();
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const sql = `
        DELETE FROM user_sessions
        WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1);
      `;
      const res = await executor.query(sql, [cutoff]);
      return res.rowCount ?? 0;
    } catch (err) {
      console.error('[session] Error purging expired sessions:', err);
      return 0;
    }
  }
}

export const defaultSessionRepository = new SessionRepository();
