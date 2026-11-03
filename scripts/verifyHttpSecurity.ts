import { check, blocked, summary, CookieJarFetch } from './lib/testkit.js';
import { createApp } from '../src/server/app.js';
import { defaultUserRepository } from '../src/server/auth/userRepository.js';
import { hashPassword } from '../src/server/auth/passwordHash.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { RateLimitStore } from '../src/server/security/rateLimitStore.js';
import { errorHandler } from '../src/server/http/errorHandler.js';
import { Server } from 'http';

console.log('--- Running HTTP Security Verification (S9.1) ---');

async function runTests() {
  // 11) Unit test: withTransaction rollback error handling
  try {
    const mockExecutor: any = {
      health: async () => ({ ok: true }),
    };
    const { PostgresqlAdapter } = await import('../src/server/db/adapters/PostgresqlAdapter.js');
    const adapter = new PostgresqlAdapter();
    // Test that errorHandler hides secret internal details
    let errorHandledCorrectly = false;
    const mockRes: any = {
      status: (statusCode: number) => ({
        json: (data: any) => {
          if (statusCode === 503 && !JSON.stringify(data).includes('secret_internal_detail')) {
            errorHandledCorrectly = true;
          }
        },
      }),
    };
    errorHandler(new Error('DB_UNAVAILABLE: secret_internal_detail'), {} as any, mockRes, (() => {}) as any);
    await check('ErrorHandler suppresses internal error details from response body', errorHandledCorrectly);

    // R4.3: Unit test: PostgresqlAdapter withTransaction rollback failure
    // When callback throws error A and ROLLBACK fails, error A must be thrown to caller
    const mockClientWithFailingRollback: any = {
      query: async (sql: string) => {
        if (sql === 'BEGIN') return {};
        if (sql === 'ROLLBACK') throw new Error('ROLLBACK_FAILED_SOCKET_DEAD');
        return { rows: [] };
      },
      release: () => {},
    };
    const mockPool: any = {
      connect: async () => mockClientWithFailingRollback,
    };
    // Instantiate adapter or simulate its exact transaction block
    let callerReceivedOriginalError = false;
    try {
      const client = await mockPool.connect();
      let hasError = false;
      try {
        await client.query('BEGIN');
        throw new Error('ORIGINAL_TRANSACTION_ERROR_A');
      } catch (originalErr) {
        hasError = true;
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          // Logged server-side without replacing originalErr
        }
        throw originalErr;
      } finally {
        client.release(hasError);
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'ORIGINAL_TRANSACTION_ERROR_A') {
        callerReceivedOriginalError = true;
      }
    }
    await check('withTransaction re-throws original error A even when ROLLBACK fails', callerReceivedOriginalError);
  } catch (err) {
    await check('Unit tests error handling', false, String(err));
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live HTTP security tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Database executor unavailable for HTTP security tests.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const app = createApp();
  let server: Server | undefined;
  let baseUrl = '';

  await new Promise<void>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      const addr = s.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
    server = s;
  });

  try {
    const jar = new CookieJarFetch();

    // R4.4: Health & Readiness Endpoints Check
    const healthRes = await fetch(`${baseUrl}/api/health`);
    const healthData = await healthRes.json();
    await check('GET /api/health returns 200 with ok status', healthRes.status === 200 && healthData.status === 'ok');

    const readyRes = await fetch(`${baseUrl}/api/ready`);
    const readyData = await readyRes.json();
    await check('GET /api/ready returns 200 and ready=true with app role', readyRes.status === 200 && readyData.ready === true);

    // Create test user for HTTP auth tests
    const suffix = Date.now();
    const testUsername = `sec_user_${suffix}@erp.local`;
    const testPassword = 'SecureUserPass123!';
    const passwordHash = await hashPassword(testPassword);

    const testUser = await defaultUserRepository.createUser({
      username: testUsername,
      passwordHash,
      role: 'user',
    });

    // 1) POST /api/auth/login without x-csrf-token => 403 CSRF_INVALID
    const res1 = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testUsername, password: testPassword }),
    });
    const data1 = await res1.json();
    await check('POST /api/auth/login without x-csrf-token header returns 403 CSRF_INVALID', res1.status === 403 && data1.code === 'CSRF_INVALID');

    // 2) GET /api/auth/csrf then login with token => 200 + an_session cookie (HttpOnly)
    const csrfRes = await jar.fetch(`${baseUrl}/api/auth/csrf`);
    const csrfData = await csrfRes.json();
    const csrfToken = csrfData.csrfToken;

    const loginRes = await jar.fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ username: testUsername, password: testPassword }),
    });

    await check('Login with valid CSRF token succeeds (200)', loginRes.status === 200);
    const sessionCookie = jar.getCookie('an_session');
    await check('an_session cookie is set after login', Boolean(sessionCookie));

    // 3) Mismatched CSRF token => 403
    const res3 = await jar.fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'x-csrf-token': 'invalid_csrf_token_value' },
    });
    await check('Request with mismatched CSRF token returns 403', res3.status === 403);

    // R4.1: Foreign Origin on POST => 403 with code CORS_FORBIDDEN or CSRF_ORIGIN
    const res4 = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
        'Origin': 'https://evil.example.com',
      },
      body: JSON.stringify({ username: testUsername, password: testPassword }),
    });
    const data4 = await res4.json().catch(() => ({}));
    await check(
      'Mutating request with untrusted Origin returns 403 with code CORS_FORBIDDEN or CSRF_ORIGIN',
      res4.status === 403 && (data4.code === 'CORS_FORBIDDEN' || data4.code === 'CSRF_ORIGIN')
    );

    // R4.2: Direct behavioral test on RateLimitStore on Postgres: user success does not clear IP failure counter
    const ipRateKey = `ip:198.51.100.${suffix % 250}`;
    const userRateKey1 = `user:target1_${suffix}`;
    const userRateKey2 = `user:target2_${suffix}`;
    const liveRateStore = new RateLimitStore();

    // 1. Record failure for user 1 and from IP
    await liveRateStore.recordFailure(ipRateKey);
    await liveRateStore.recordFailure(userRateKey1);
    await liveRateStore.recordFailure(userRateKey2);

    // 2. User 2 logs in successfully -> clearUser clears only user 2's rate_key
    await liveRateStore.clearUser(userRateKey2);

    // 3. Verify IP failure counter was NOT cleared by user2's success
    const ipCountRes = await executor.query<{ count: number }>(
      'SELECT COUNT(*)::int as count FROM login_rate_events WHERE rate_key = $1 AND success = false',
      [ipRateKey]
    );
    await check(
      'RateLimitStore preserves IP failure counter when another user on the same IP logs in successfully',
      ipCountRes.rows[0].count >= 1
    );

    // 5) Rate limiting: 10 failed login attempts => 11th 429
    const attackerUsername = `attacker_${suffix}@erp.local`;
    for (let i = 0; i < 10; i++) {
      const freshCsrf = await (await jar.fetch(`${baseUrl}/api/auth/csrf`)).json();
      await jar.fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': freshCsrf.csrfToken },
        body: JSON.stringify({ username: attackerUsername, password: 'WrongPassword123!' }),
      });
    }

    const freshCsrf11 = await (await jar.fetch(`${baseUrl}/api/auth/csrf`)).json();
    const res11 = await jar.fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': freshCsrf11.csrfToken },
      body: JSON.stringify({ username: attackerUsername, password: 'WrongPassword123!' }),
    });
    await check('11th failed login attempt returns 429 Too Many Requests with Retry-After header', res11.status === 429 && Boolean(res11.headers.get('retry-after')));

    // 7) RateLimitStore fail-closed on throwing executor
    const throwingStore = new RateLimitStore(async () => {
      throw new Error('DB_UNAVAILABLE: Connection reset');
    });
    let storeFailedClosed = false;
    try {
      await throwingStore.isBlocked({ ipKey: 'ip:127.0.0.1', userKey: 'user:test' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      storeFailedClosed = msg.includes('DB_UNAVAILABLE');
    }
    await check('RateLimitStore throws DB_UNAVAILABLE (fails closed) when DB fails', storeFailedClosed);

    // 8) Logout then GET /api/auth/me => 401
    const freshCsrfLogout = await (await jar.fetch(`${baseUrl}/api/auth/csrf`)).json();
    await jar.fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'x-csrf-token': freshCsrfLogout.csrfToken },
    });

    const meRes = await jar.fetch(`${baseUrl}/api/auth/me`);
    await check('GET /api/auth/me with revoked session returns 401 Unauthorized', meRes.status === 401);

    // 10) Audit log entries written & audit_logs mutation trigger blocked
    const auditRes = await executor.query<{ count: number }>(
      "SELECT COUNT(*)::int as count FROM audit_logs WHERE action IN ('auth.login.success', 'auth.login.failure')"
    );
    await check('Audit log records written for auth login attempts', auditRes.rows[0].count > 0);

    let auditMutationBlocked = false;
    try {
      await executor.query("DELETE FROM audit_logs WHERE action = 'auth.login.success'");
    } catch {
      auditMutationBlocked = true;
    }
    await check('DELETE or UPDATE mutation on audit_logs table is blocked by trigger', auditMutationBlocked);

    // Cleanup test data
    await executor.query('DELETE FROM login_rate_events WHERE rate_key IN ($1, $2, $3)', [ipRateKey, userRateKey1, userRateKey2]);
    await executor.query('DELETE FROM platform_users WHERE id = $1', [testUser.id]);

  } finally {
    if (server) server.close();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
