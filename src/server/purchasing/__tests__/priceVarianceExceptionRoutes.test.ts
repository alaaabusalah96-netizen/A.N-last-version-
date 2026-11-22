import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { createApp } from '../../app.js';
import { defaultAuthService } from '../../auth/authService.js';
import { defaultCompanyStore } from '../../org/companyStore.js';
import { defaultRbacService } from '../../rbac/rbacService.js';
import { defaultPriceVarianceExceptionService } from '../priceVarianceExceptionService.js';
import { PERMISSIONS } from '../../rbac/permissions.js';
import { ValidationError } from '../../http/errors.js';

const COMP_1 = '11111111-1111-4111-8111-111111111111';
const COMP_2 = '22222222-2222-4222-8222-222222222222';
const INV_1 = '33333333-3333-4333-8333-333333333333';
const EXC_1 = '44444444-4444-4444-8444-444444444444';
const USER_REQ = '55555555-5555-4555-8555-555555555555';
const USER_APP = '66666666-6666-4666-8666-666666666666';

describe('Purchasing Price Variance Exception HTTP Routes', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function getCsrfForSession(sessionToken: string): Promise<{ cookieHeader: string; csrfToken: string }> {
    const res = await fetch(`${baseUrl}/api/auth/csrf`, {
      headers: {
        Cookie: `an_session=${sessionToken}`,
      },
    });
    const data = await res.json();
    return {
      csrfToken: data.csrfToken,
      cookieHeader: `an_session=${sessionToken}; an_csrf=${data.csrfToken}`,
    };
  }

  function mockSessionAndCompany(options: {
    userId: string;
    username: string;
    role?: 'company_user' | 'company_admin' | 'platform_admin';
    allowedPermissions?: string[];
    allowedCompanyIds?: string[];
  }) {
    vi.spyOn(defaultAuthService, 'getSessionUser').mockResolvedValue({
      id: options.userId,
      username: options.username,
      role: options.role || 'company_user',
      isActive: true,
    } as any);

    const allowedCompanies = options.allowedCompanyIds || [COMP_1];
    vi.spyOn(defaultCompanyStore, 'getById').mockImplementation(async (companyId: string) => {
      if (companyId === COMP_1) {
        return { id: COMP_1, code: 'C1', nameAr: 'شركة 1' } as any;
      }
      return null;
    });

    vi.spyOn(defaultRbacService, 'hasPermission').mockImplementation(async (_u, perm, companyId) => {
      if (!companyId || !allowedCompanies.includes(companyId)) return false;
      return (options.allowedPermissions || []).includes(perm);
    });
  }

  it('rejects unauthenticated requests with 401', async () => {
    const res = await fetch(`${baseUrl}/api/purchasing/supplier-invoices/${INV_1}/price-exceptions?companyId=${COMP_1}`);
    expect(res.status).toBe(401);
  });

  it('enforces RBAC on request, approve, reject, and list routes', async () => {
    mockSessionAndCompany({
      userId: USER_REQ,
      username: 'requester',
      allowedPermissions: [PERMISSIONS.PURCHASING_READ], // no variance request/approve
    });
    const { cookieHeader, csrfToken } = await getCsrfForSession('tok-read-only');

    const reqDenied = await fetch(`${baseUrl}/api/purchasing/supplier-invoices/${INV_1}/price-exceptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ companyId: COMP_1, reason: 'Price increased' }),
    });
    expect(reqDenied.status).toBe(403);

    const appDenied = await fetch(`${baseUrl}/api/purchasing/price-exceptions/${EXC_1}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ companyId: COMP_1, decisionReason: 'Ok' }),
    });
    expect(appDenied.status).toBe(403);

    const rejDenied = await fetch(`${baseUrl}/api/purchasing/price-exceptions/${EXC_1}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ companyId: COMP_1, decisionReason: 'No' }),
    });
    expect(rejDenied.status).toBe(403);

    const listSpy = vi.spyOn(defaultPriceVarianceExceptionService, 'listExceptions').mockResolvedValueOnce([]);
    const listAllowed = await fetch(
      `${baseUrl}/api/purchasing/supplier-invoices/${INV_1}/price-exceptions?companyId=${COMP_1}`,
      { headers: { Cookie: cookieHeader } }
    );
    expect(listAllowed.status).toBe(200);
    expect(listSpy).toHaveBeenCalledWith(COMP_1, INV_1);
  });

  it('derives actorId strictly from session user (ignoring spoofed body actorId/requestedBy) and rejects conflicting companyId', async () => {
    mockSessionAndCompany({
      userId: USER_REQ,
      username: 'requester',
      allowedPermissions: [PERMISSIONS.PURCHASING_VARIANCE_REQUEST],
    });
    const { cookieHeader, csrfToken } = await getCsrfForSession('tok-req');

    const reqSpy = vi.spyOn(defaultPriceVarianceExceptionService, 'requestException').mockResolvedValueOnce({
      id: EXC_1,
      companyId: COMP_1,
      invoiceId: INV_1,
      supplierId: 'sup-1',
      status: 'pending',
      requestedBy: USER_REQ,
      approvedBy: null,
      rejectedBy: null,
      reason: 'Vendor price hike',
      decisionReason: null,
      fingerprint: 'fp',
      snapshot: {},
      maxVariancePc: 12,
      createdAt: '2026-11-20T00:00:00Z',
      updatedAt: '2026-11-20T00:00:00Z',
    });

    const okRes = await fetch(`${baseUrl}/api/purchasing/supplier-invoices/${INV_1}/price-exceptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({
        companyId: COMP_1,
        reason: 'Vendor price hike',
        actorId: '99999999-9999-4999-8999-999999999999',
        requestedBy: '99999999-9999-4999-8999-999999999999',
      }),
    });
    expect(okRes.status).toBe(201);
    expect(reqSpy).toHaveBeenCalledWith(COMP_1, INV_1, 'Vendor price hike', USER_REQ);

    // Conflicting companyId in query vs body MUST return 400 without calling service
    const mismatchRes = await fetch(
      `${baseUrl}/api/purchasing/supplier-invoices/${INV_1}/price-exceptions?companyId=${COMP_2}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ companyId: COMP_1, reason: 'Tampered company' }),
      }
    );
    expect(mismatchRes.status).toBe(400);
    expect(reqSpy).toHaveBeenCalledTimes(1);
  });

  it('approves and rejects exceptions using trusted approver userId and maps SoD ValidationError to 400', async () => {
    mockSessionAndCompany({
      userId: USER_APP,
      username: 'approver',
      allowedPermissions: [PERMISSIONS.PURCHASING_VARIANCE_APPROVE],
    });
    const { cookieHeader, csrfToken } = await getCsrfForSession('tok-app');

    const approveSpy = vi
      .spyOn(defaultPriceVarianceExceptionService, 'approveException')
      .mockResolvedValueOnce({ id: EXC_1, status: 'approved', approvedBy: USER_APP } as any)
      .mockRejectedValueOnce(new ValidationError('قواعد فصل المهام (SoD) تمنع مقدم طلب الاستثناء من اعتماده بنفسه'));

    const resApprove = await fetch(`${baseUrl}/api/purchasing/price-exceptions/${EXC_1}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ companyId: COMP_1, decisionReason: 'Approved by CFO', actorId: USER_REQ }),
    });
    expect(resApprove.status).toBe(200);
    expect(approveSpy).toHaveBeenCalledWith(COMP_1, EXC_1, 'Approved by CFO', USER_APP);

    const resSod = await fetch(`${baseUrl}/api/purchasing/price-exceptions/${EXC_1}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ companyId: COMP_1, decisionReason: 'Self approve attempt' }),
    });
    expect(resSod.status).toBe(400);
    const sodJson = await resSod.json();
    expect(sodJson.error).toContain('فصل المهام');

    const rejectSpy = vi
      .spyOn(defaultPriceVarianceExceptionService, 'rejectException')
      .mockResolvedValueOnce({ id: EXC_1, status: 'rejected', rejectedBy: USER_APP } as any);

    const resReject = await fetch(`${baseUrl}/api/purchasing/price-exceptions/${EXC_1}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ companyId: COMP_1, decisionReason: 'Price too high' }),
    });
    expect(resReject.status).toBe(200);
    expect(rejectSpy).toHaveBeenCalledWith(COMP_1, EXC_1, 'Price too high', USER_APP);
  });

  it('rejects cross-company access with 404 or 403', async () => {
    mockSessionAndCompany({
      userId: USER_REQ,
      username: 'requester',
      allowedPermissions: [PERMISSIONS.PURCHASING_READ],
      allowedCompanyIds: [COMP_1],
    });
    const res = await fetch(
      `${baseUrl}/api/purchasing/supplier-invoices/${INV_1}/price-exceptions?companyId=${COMP_2}`,
      { headers: { Cookie: 'an_session=tok-cross' } }
    );
    expect([403, 404]).toContain(res.status);
  });
});
