import { check, summary } from './lib/testkit.js';
import express, { Request, Response, NextFunction } from 'express';
import { requireCompanyAccess } from '../src/server/http/tenantScope.js';
import { tenantContextStorage } from '../src/server/db/tenantContext.js';
import { errorHandler } from '../src/server/http/errorHandler.js';
import { PERMISSIONS } from '../src/server/rbac/permissions.js';

console.log('--- Running Tenant Scope Middleware Verification (F10-7) ---');

async function runTests() {
  const dummyUser: any = {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'test_user',
    role: 'user',
  };

  // Mock RbacService
  const mockRbacService: any = {
    hasPermission: async (user: any, perm: string, compId: string) => {
      if (compId === '33333333-3333-4333-8333-333333333333') {
        throw new Error('DB_UNAVAILABLE: Database connection dropped');
      }
      return compId === '22222222-2222-4222-8222-222222222222';
    },
  };

  const app = express();
  app.use(express.json());

  // Attach mock user
  app.use((req: any, _res: any, next: NextFunction) => {
    req.user = dummyUser;
    next();
  });

  app.get(
    '/test/:companyId',
    requireCompanyAccess(PERMISSIONS.COMPANY_READ, mockRbacService),
    (req: Request, res: Response) => {
      const activeTenant = tenantContextStorage.getCurrentCompanyId();
      res.status(200).json({ status: 'ok', activeTenant });
    }
  );

  app.use(errorHandler);

  let server: any;
  let baseUrl = '';
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  try {
    // 1. Invalid UUID -> 400 VALIDATION_ERROR
    const resInvalid = await fetch(`${baseUrl}/test/not-a-valid-uuid`);
    const dataInvalid = await resInvalid.json();
    await check('Invalid UUID in path returns 400 VALIDATION_ERROR without crashing server', resInvalid.status === 400 && dataInvalid.code === 'VALIDATION_ERROR');

    // 2. Disallowed company -> 403 FORBIDDEN
    const resForbidden = await fetch(`${baseUrl}/test/44444444-4444-4444-8444-444444444444`);
    const dataForbidden = await resForbidden.json();
    await check('Unpermitted company returns 403 FORBIDDEN', resForbidden.status === 403 && dataForbidden.code === 'FORBIDDEN');

    // 3. RBAC error (DB_UNAVAILABLE) -> returns 503 per F8 error mapping
    const resError = await fetch(`${baseUrl}/test/33333333-3333-4333-8333-333333333333`);
    await check('Internal error (DB_UNAVAILABLE) in RBAC service returns 503 without crashing process', resError.status === 503);

    // 4. Allowed company -> 200 with tenantContextStorage correctly active
    const resSuccess = await fetch(`${baseUrl}/test/22222222-2222-4222-8222-222222222222`);
    const dataSuccess = await resSuccess.json();
    await check('Allowed company returns 200 and passes active tenantContextStorage', resSuccess.status === 200 && dataSuccess.activeTenant === '22222222-2222-4222-8222-222222222222');
  } finally {
    if (server) server.close();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
