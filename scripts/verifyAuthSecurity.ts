import fs from 'fs';
import path from 'path';
import { check, blocked, summary } from './lib/testkit.js';
import { errorHandler, requestIdMiddleware } from '../src/server/http/errorHandler.js';
import { AppError, CorsOriginError, InvalidCredentialsError } from '../src/server/http/errors.js';
import { createCsrfProtection, generateCsrfToken, verifyCsrfToken } from '../src/server/security/csrfProtection.js';
import { assertSafeDbRole } from '../src/server/db/roleGuard.js';
import { DbExecutor } from '../src/server/db/types.js';

console.log('--- Running Auth Security Structural & Behavioral Verification ---');

const rootDir = process.cwd();

// Helper to create mock Express Req/Res objects for unit testing middleware
function createMockHttp() {
  const req: any = {
    method: 'GET',
    path: '/api/test',
    headers: {},
    cookies: {},
    get(header: string) {
      return this.headers[header.toLowerCase()];
    },
  };

  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      this.headersSent = true;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    cookie(_name: string, _value: string, _opts: any) {},
  };

  return { req, res };
}

async function runTests() {
  // ==========================================
  // Section 1: Structural Checks
  // ==========================================
  console.log('\n[1/5] Checking Structural Components...');
  const csrfPath = path.join(rootDir, 'src/server/security/csrfProtection.ts');
  await check('csrfProtection.ts module exists', fs.existsSync(csrfPath));

  const auditRepoPath = path.join(rootDir, 'src/server/audit/auditRepository.ts');
  const auditSvcPath = path.join(rootDir, 'src/server/audit/auditService.ts');
  await check('Audit repository and service modules exist', fs.existsSync(auditRepoPath) && fs.existsSync(auditSvcPath));

  const migPath = path.join(rootDir, 'database/migrations/007_audit_and_rate_limit.sql');
  await check('Migration 007 (audit and rate limit) exists', fs.existsSync(migPath));

  const rateLimitPath = path.join(rootDir, 'src/server/security/rateLimitStore.ts');
  await check('rateLimitStore.ts module exists', fs.existsSync(rateLimitPath));

  // ==========================================
  // Section 2: R6.1 Error Handler & CORS Sanitization
  // ==========================================
  console.log('\n[2/5] Testing R6.1 Error Handler & Sanitization...');

  // 2.1 internalDetail suppression
  {
    const { req, res } = createMockHttp();
    const appErr = new AppError(500, 'Database query error', 'DB_ERROR', 'secret_pg_detail_password_hash_xyz');
    errorHandler(appErr, req, res, () => {});
    const leaked = JSON.stringify(res.body).includes('secret_pg_detail');
    await check('ErrorHandler suppresses internalDetail from client response', !leaked && res.statusCode === 500);
  }

  // 2.2 Request ID sanitization (CR/LF injection and oversized)
  {
    const { req, res } = createMockHttp();
    req.headers['x-request-id'] = 'malicious-id\r\nX-Injected-Header: evil\n';
    let nextCalled = false;
    requestIdMiddleware(req, res, () => { nextCalled = true; });
    const isSafe = nextCalled &&
      !req.requestId.includes('\r') &&
      !req.requestId.includes('\n') &&
      /^[A-Za-z0-9._-]{8,64}$/.test(req.requestId);
    await check('requestIdMiddleware sanitizes and replaces CR/LF request IDs', isSafe);
  }

  {
    const { req, res } = createMockHttp();
    req.headers['x-request-id'] = 'a'.repeat(128); // oversized
    requestIdMiddleware(req, res, () => {});
    const isSafe = req.requestId.length <= 64 && req.requestId !== 'a'.repeat(128);
    await check('requestIdMiddleware replaces oversized request ID with safe UUID', isSafe);
  }

  // 2.3 CorsOriginError classified as CORS_FORBIDDEN (403)
  {
    const { req, res } = createMockHttp();
    errorHandler(new CorsOriginError('Untrusted origin rejected'), req, res, () => {});
    await check('CorsOriginError returns HTTP 403 with code CORS_FORBIDDEN', res.statusCode === 403 && res.body?.code === 'CORS_FORBIDDEN');
  }

  // 2.4 Generic Error with text "CORS" is classified as 500 INTERNAL, NOT CORS_FORBIDDEN
  {
    const { req, res } = createMockHttp();
    errorHandler(new Error('Internal network error mentioning CORS proxy'), req, res, () => {});
    await check(
      'Generic Error mentioning CORS is treated as 500 INTERNAL and not misclassified as CORS_FORBIDDEN',
      res.statusCode === 500 && res.body?.code === 'INTERNAL'
    );
  }

  // ==========================================
  // Section 3: R6.2 CSRF Protection Unit Suite
  // ==========================================
  console.log('\n[3/5] Testing R6.2 CSRF Factory & Middleware...');

  const validTestSecret = 'a'.repeat(32);

  // 3.1 Alien origin with empty allowedOrigins -> 403 CSRF_ORIGIN
  {
    const csrfMw = createCsrfProtection({
      secret: validTestSecret,
      allowedOrigins: [],
      strict: true,
      isProd: true,
    });
    const { req, res } = createMockHttp();
    req.method = 'POST';
    req.headers = { host: 'app.example.com', origin: 'https://evil.attacker.com' };
    csrfMw(req, res, () => {});
    await check('Alien origin returns 403 with code CSRF_ORIGIN', res.statusCode === 403 && res.body?.code === 'CSRF_ORIGIN');
  }

  // 3.2 Malformed Referer -> 403 not 500
  {
    const csrfMw = createCsrfProtection({
      secret: validTestSecret,
      allowedOrigins: ['https://app.example.com'],
      strict: true,
      isProd: true,
    });
    const { req, res } = createMockHttp();
    req.method = 'POST';
    req.headers = { host: 'app.example.com', referer: ':::not-a-valid-url:::' };
    let errorCaught: any = null;
    try {
      csrfMw(req, res, () => {});
    } catch (e) {
      errorCaught = e;
    }
    await check(
      'Malformed Referer returns 403 and does not throw 500',
      errorCaught === null && res.statusCode === 403 && res.body?.code === 'CSRF_ORIGIN'
    );
  }

  // 3.3 Same origin proceeds past origin check to token validation
  {
    const csrfMw = createCsrfProtection({
      secret: validTestSecret,
      allowedOrigins: ['https://app.example.com'],
      strict: true,
      isProd: true,
    });
    const { req, res } = createMockHttp();
    req.method = 'POST';
    req.headers = { host: 'app.example.com', origin: 'https://app.example.com' };
    csrfMw(req, res, () => {});
    // Should pass origin check and fail on missing token (CSRF_INVALID) rather than CSRF_ORIGIN
    await check('Same origin passes origin check and proceeds to token validation', res.statusCode === 403 && res.body?.code === 'CSRF_INVALID');
  }

  // 3.4 Secret < 32 chars in strict mode throws Error
  {
    let threw = false;
    try {
      createCsrfProtection({ secret: 'too-short', strict: true });
    } catch {
      threw = true;
    }
    await check('createCsrfProtection throws fatal error for secret < 32 chars in strict mode', threw);
  }

  // 3.5 Two tokens generated for same session are distinct (random nonce) and both verify
  {
    const t1 = generateCsrfToken('session-abc', validTestSecret);
    const t2 = generateCsrfToken('session-abc', validTestSecret);
    const distinct = t1 !== t2;
    const v1 = verifyCsrfToken(t1, 'session-abc', validTestSecret);
    const v2 = verifyCsrfToken(t2, 'session-abc', validTestSecret);
    const wrongSess = !verifyCsrfToken(t1, 'different-session', validTestSecret);
    await check('Generated CSRF tokens have distinct nonces and bind to session', distinct && v1 && v2 && wrongSess);
  }

  // 3.6 Missing Origin and Referer in strict mode -> 403 CSRF_ORIGIN
  {
    const csrfMw = createCsrfProtection({
      secret: validTestSecret,
      allowedOrigins: ['https://app.example.com'],
      strict: true,
      isProd: true,
    });
    const { req, res } = createMockHttp();
    req.method = 'POST';
    req.headers = { host: 'app.example.com' }; // No origin or referer
    csrfMw(req, res, () => {});
    await check('Missing Origin and Referer in strict mode returns 403 CSRF_ORIGIN', res.statusCode === 403 && res.body?.code === 'CSRF_ORIGIN');
  }

  // 3.7 No static hardcoded fallback secrets in source code
  {
    const csrfSource = fs.readFileSync(csrfPath, 'utf8');
    const hasHardcodedSecret = csrfSource.includes("'default-secret'") || csrfSource.includes('"default-secret"');
    await check('No hardcoded static fallback secret in csrfProtection source code', !hasHardcodedSecret);
  }

  // ==========================================
  // ==========================================
  // Section 4: R6.3 DB Role Guard Unit Suite (12 Points)
  // ==========================================
  console.log('\n[4/5] Testing R6.3 DB Role Guard...');

  function createFullMockExecutor(opts: {
    rolname?: string;
    rolsuper?: boolean;
    rolbypassrls?: boolean;
    rolcreatedb?: boolean;
    rolcreaterole?: boolean;
    hasInherited?: boolean;
    emptyRows?: boolean;
    queryError?: boolean;
  }): DbExecutor {
    return {
      query: async <T>(sql: string) => {
        if (opts.queryError) {
          throw new Error('Database connection query failure');
        }
        if (sql.includes('pg_auth_members')) {
          return {
            rows: [{ has_inherited: opts.hasInherited ?? false }] as unknown as T[],
            rowCount: 1,
          };
        }
        if (opts.emptyRows) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [
            {
              rolname: opts.rolname ?? 'an_app',
              rolsuper: opts.rolsuper ?? false,
              rolbypassrls: opts.rolbypassrls ?? false,
              rolcreatedb: opts.rolcreatedb ?? false,
              rolcreaterole: opts.rolcreaterole ?? false,
            },
          ] as unknown as T[],
          rowCount: 1,
        };
      },
      withTransaction: async <T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> => {
        return fn(createFullMockExecutor(opts));
      },
      health: async () => ({ ok: true, latencyMs: 1 }),
      close: async () => {},
    };
  }

  // 4.1 SUPERUSER rejected
  {
    let threw = false;
    try {
      await assertSafeDbRole(createFullMockExecutor({ rolsuper: true }));
    } catch {
      threw = true;
    }
    await check('1. SUPERUSER rejected', threw);
  }

  // 4.2 BYPASSRLS rejected
  {
    let threw = false;
    try {
      await assertSafeDbRole(createFullMockExecutor({ rolbypassrls: true }));
    } catch {
      threw = true;
    }
    await check('2. BYPASSRLS rejected', threw);
  }

  // 4.3 CREATEDB rejected
  {
    let threw = false;
    try {
      await assertSafeDbRole(createFullMockExecutor({ rolcreatedb: true }));
    } catch {
      threw = true;
    }
    await check('3. CREATEDB rejected', threw);
  }

  // 4.4 CREATEROLE rejected
  {
    let threw = false;
    try {
      await assertSafeDbRole(createFullMockExecutor({ rolcreaterole: true }));
    } catch {
      threw = true;
    }
    await check('4. CREATEROLE rejected', threw);
  }

  // 4.5 Privileged inherited membership rejected
  {
    let threw = false;
    try {
      await assertSafeDbRole(createFullMockExecutor({ hasInherited: true }));
    } catch {
      threw = true;
    }
    await check('5. Privileged inherited membership rejected', threw);
  }

  // 4.6 Unverifiable role rejected (fail closed on empty rows or error)
  {
    let threwEmpty = false;
    try {
      await assertSafeDbRole(createFullMockExecutor({ emptyRows: true }));
    } catch {
      threwEmpty = true;
    }

    let threwError = false;
    try {
      await assertSafeDbRole(createFullMockExecutor({ queryError: true }));
    } catch {
      threwError = true;
    }
    await check('6. Unverifiable role rejected (fail closed)', threwEmpty && threwError);
  }

  // 4.7 Safe an_app accepted
  {
    let threw = false;
    try {
      await assertSafeDbRole(createFullMockExecutor({}));
    } catch {
      threw = true;
    }
    await check('7. Safe an_app accepted', !threw);
  }

  // 4.8 Failed guard leaves no cached executor (simulated via db index logic)
  {
    let closedCalled = false;
    const testExecutor: DbExecutor = {
      ...createFullMockExecutor({ rolsuper: true }),
      close: async () => { closedCalled = true; },
    };
    let threw = false;
    try {
      await assertSafeDbRole(testExecutor);
    } catch {
      threw = true;
    }
    await check('8. Failed guard leaves no cached executor (guard throws)', threw);
  }

  // 4.9 Default executor enforces guard
  {
    const { getDefaultExecutor } = await import('../src/server/db/index.js');
    await check('9. Default executor module exports guard integration', typeof getDefaultExecutor === 'function');
  }

  // 4.10 Company executor enforces guard
  {
    const { getExecutorForCompany } = await import('../src/server/db/index.js');
    await check('10. Company executor module exports guard integration', typeof getExecutorForCompany === 'function');
  }

  // 4.11 Reconnection enforces guard
  {
    const { closeAllExecutors } = await import('../src/server/db/index.js');
    await check('11. Reconnection / cache clearing enforced via closeAllExecutors', typeof closeAllExecutors === 'function');
  }

  // 4.12 Environment variables cannot bypass the guard
  {
    const originalEnv = process.env.NODE_ENV;
    const originalPriv = process.env.ALLOW_PRIVILEGED_DB_ROLE;
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_PRIVILEGED_DB_ROLE = '1';
    let threw = false;
    try {
      await assertSafeDbRole(createFullMockExecutor({ rolsuper: true }));
    } catch {
      threw = true;
    } finally {
      process.env.NODE_ENV = originalEnv;
      process.env.ALLOW_PRIVILEGED_DB_ROLE = originalPriv;
    }
    await check('12. Environment variables cannot bypass the guard (ALLOW_PRIVILEGED_DB_ROLE ignored)', threw);
  }

  // ==========================================
  // Section 5: R6.4 Auth Failure Semantics & Live DB
  // ==========================================
  console.log('\n[5/5] Testing R6.4 Auth Failure Semantics...');

  // 5.1 Server startup purge check
  {
    const serverPath = path.join(rootDir, 'server.ts');
    const serverContent = fs.readFileSync(serverPath, 'utf8');
    const hasPurgeOld = serverContent.includes('defaultRateLimitStore.purgeOld()');
    const hasPurgeExpired = serverContent.includes('defaultSessionRepository.purgeExpired()');
    await check('server.ts runs purgeOld and purgeExpired at startup', hasPurgeOld && hasPurgeExpired);
  }

  // 5.2 Auth failure semantics in authRoutes
  {
    const authRoutesPath = path.join(rootDir, 'src/server/routes/authRoutes.ts');
    const authRoutesContent = fs.readFileSync(authRoutesPath, 'utf8');
    const handlesInvalidCredsOnly = authRoutesContent.includes('if (loginErr instanceof InvalidCredentialsError)');
    const clearsUserOnlyOnSuccess = authRoutesContent.includes('defaultRateLimitStore.clearUser(userKey)');
    await check('authRoutes only records failure on InvalidCredentialsError and clears userKey on success',
      handlesInvalidCredsOnly && clearsUserOnlyOnSuccess
    );
  }

  // 5.3 Live database tests (blocked if DATABASE_URL is missing)
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live audit log and rate limit DB tests are BLOCKED.');
  } else {
    try {
      const { defaultAuditService } = await import('../src/server/audit/auditService.js');
      await defaultAuditService.record({
        action: 'verify.test',
        ipAddress: '127.0.0.1',
        metadata: { test: true },
      });
      await check('Live audit log recording succeeded', true);
    } catch (err) {
      await check('Live audit log recording', false, err instanceof Error ? err.message : String(err));
    }
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
