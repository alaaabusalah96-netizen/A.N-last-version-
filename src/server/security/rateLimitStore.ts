import { getDefaultExecutor } from '../db/index.js';
import { DbExecutor } from '../db/types.js';

export interface RateLimitCheckResult {
  blocked: boolean;
  retryAfterSec?: number;
  reason?: string;
}

export class RateLimitStore {
  private windowMinutes: number;
  private maxFailedPerIp: number;
  private maxFailedPerUser: number;

  constructor(private executorProvider: () => Promise<DbExecutor | null> = getDefaultExecutor) {
    this.maxFailedPerIp = parseInt(process.env.LOGIN_MAX_FAILED_PER_IP || '20', 10);
    this.maxFailedPerUser = parseInt(process.env.LOGIN_MAX_FAILED_PER_USER || '10', 10);
    this.windowMinutes = parseInt(process.env.LOGIN_WINDOW_MINUTES || '15', 10);
  }

  private async getExecutor(): Promise<DbExecutor> {
    const executor = await this.executorProvider();
    if (!executor) {
      throw new Error('DB_UNAVAILABLE: Database executor required for rate limit check');
    }
    return executor;
  }

  async isBlocked(keys: { ipKey: string; userKey: string }): Promise<RateLimitCheckResult> {
    const executor = await this.getExecutor();
    const windowStart = new Date(Date.now() - this.windowMinutes * 60 * 1000);

    const sql = `
      SELECT rate_key, COUNT(*)::int as count, MIN(attempt_at) as oldest_attempt
      FROM login_rate_events
      WHERE rate_key IN ($1, $2) AND success = false AND attempt_at >= $3
      GROUP BY rate_key;
    `;

    const res = await executor.query<{ rate_key: string; count: number; oldest_attempt: Date }>(sql, [
      keys.ipKey,
      keys.userKey,
      windowStart,
    ]);

    for (const row of res.rows) {
      const isIp = row.rate_key === keys.ipKey;
      const limit = isIp ? this.maxFailedPerIp : this.maxFailedPerUser;

      if (row.count >= limit) {
        const oldestTime = new Date(row.oldest_attempt).getTime();
        const resetTime = oldestTime + this.windowMinutes * 60 * 1000;
        const retryAfterSec = Math.max(1, Math.ceil((resetTime - Date.now()) / 1000));

        return {
          blocked: true,
          retryAfterSec,
          reason: isIp ? 'Too many failed login attempts from this IP' : 'Too many failed login attempts for this account',
        };
      }
    }

    return { blocked: false };
  }

  async recordFailure(key: string): Promise<void> {
    const executor = await this.getExecutor();
    const sql = `INSERT INTO login_rate_events (rate_key, success) VALUES ($1, false);`;
    await executor.query(sql, [key]);
  }

  async clearUser(userKey: string): Promise<void> {
    const executor = await this.getExecutor();
    const sql = `DELETE FROM login_rate_events WHERE rate_key = $1 AND success = false;`;
    await executor.query(sql, [userKey]);
  }

  async purgeOld(): Promise<void> {
    try {
      const executor = await this.getExecutor();
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await executor.query('DELETE FROM login_rate_events WHERE attempt_at < $1;', [cutoff]);
    } catch (err) {
      console.error('[rateLimit] Error purging old rate limit events:', err);
    }
  }
}

export const defaultRateLimitStore = new RateLimitStore();

// Interval for hourly cleanup
const purgeTimer = setInterval(() => {
  defaultRateLimitStore.purgeOld().catch(() => {});
}, 60 * 60 * 1000);
if (purgeTimer.unref) purgeTimer.unref();
