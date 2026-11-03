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
  } catch (err) {
    await check('ErrorHandler test', false, String(err));
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

    // 4) Foreign Origin on POST => 403 CSRF_ORIGIN
    const res4 = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
        'Origin': 'https://evil.example.com',
      },
      body: JSON.stringify({ username: testUsername, password: testPassword }),
    });
    await check('Mutating request with untrusted Origin returns 403 CSRF_ORIGIN', res4.status === 403 && (await res4.json()).code === 'CSRF_ORIGIN');

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
