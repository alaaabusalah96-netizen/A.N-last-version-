import { getDefaultExecutor } from '../db/index.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

export class RateLimitStore {
  private windowMinutes = 15;
  private maxFailedAttempts = 10;

  async hit(key: string): Promise<RateLimitResult> {
    try {
      const executor = await getDefaultExecutor();
      if (!executor) {
        return { allowed: true, remaining: this.maxFailedAttempts };
      }

      const now = new Date();
      const windowStart = new Date(now.getTime() - this.windowMinutes * 60 * 1000);

      // Count failed attempts in the current window
      const countSql = `
        SELECT COUNT(*)::int as count
        FROM login_rate_events
        WHERE rate_key = $1 AND success = false AND attempt_at >= $2;
      `;

      const res = await executor.query<{ count: number }>(countSql, [key, windowStart]);
      const failedCount = res.rows[0]?.count || 0;

      if (failedCount >= this.maxFailedAttempts) {
        return { allowed: false, remaining: 0 };
      }

      return { allowed: true, remaining: this.maxFailedAttempts - failedCount };
    } catch (err) {
      console.error('[rateLimit] Error checking rate limit:', err);
      return { allowed: true, remaining: this.maxFailedAttempts };
    }
  }

  async recordAttempt(key: string, success: boolean): Promise<void> {
    try {
      const executor = await getDefaultExecutor();
      if (!executor) return;

      const sql = `
        INSERT INTO login_rate_events (rate_key, success)
        VALUES ($1, $2);
      `;
      await executor.query(sql, [key, success]);

      if (success) {
        // Clear failed events on successful login
        const clearSql = `
          DELETE FROM login_rate_events
          WHERE rate_key = $1 AND success = false;
        `;
        await executor.query(clearSql, [key]);
      }
    } catch (err) {
      console.error('[rateLimit] Error recording attempt:', err);
    }
  }
}

export const defaultRateLimitStore = new RateLimitStore();
