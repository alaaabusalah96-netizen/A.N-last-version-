import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultCashRegisterService } from '../cash/cashRegisterService.js';
import { defaultCustodyService } from '../cash/custodyService.js';
import { CustodyStatus } from '../cash/cashTypes.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';

export const cashRoutes = Router();

async function assertCashPermission(
  user: AuthenticatedRequest['user'],
  permission: string,
  companyId: string
): Promise<void> {
  if (!companyId || !isUuid(companyId)) {
    throw new ValidationError('Invalid or missing company ID format');
  }
  const company = await defaultCompanyStore.getById(companyId);
  if (!company) {
    throw new NotFoundError('Company not found');
  }
  const allowed = await defaultRbacService.hasPermission(user!, permission, companyId);
  if (!allowed) {
    throw new ForbiddenError(`Access denied: Missing required permission '${permission}' for this company`);
  }
}

// ============================================================================
// Cash Registers (الصناديق / الخزائن)
// ============================================================================

// 1. List Cash Registers
cashRoutes.get(
  '/registers',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CASH_READ, companyId);
    const registers = await defaultCashRegisterService.listRegisters(companyId);
    res.json({ status: 'ok', registers });
  })
);

// 2. Create Cash Register
cashRoutes.post(
  '/registers',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CASH_WRITE, companyId);
    const register = await defaultCashRegisterService.createRegister(companyId, req.body, user.id);
    res.status(201).json({ status: 'ok', register });
  })
);

// 3. Get Cash Register by ID
cashRoutes.get(
  '/registers/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف الصندوق غير صالح');
    }
    const companyId = (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CASH_READ, companyId);
    const register = await defaultCashRegisterService.getRegister(companyId, id);
    res.json({ status: 'ok', register });
  })
);

// 4. Update Cash Register
cashRoutes.patch(
  '/registers/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف الصندوق غير صالح');
    }
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CASH_WRITE, companyId);
    const register = await defaultCashRegisterService.updateRegister(companyId, id, req.body, user.id);
    res.json({ status: 'ok', register });
  })
);

// 5. Deactivate Cash Register
cashRoutes.post(
  '/registers/:id/deactivate',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف الصندوق غير صالح');
    }
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CASH_WRITE, companyId);
    const register = await defaultCashRegisterService.deactivateRegister(companyId, id, user.id);
    res.json({ status: 'ok', register });
  })
);

// 6. Get Cash Register Balance
cashRoutes.get(
  '/registers/:id/balance',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف الصندوق غير صالح');
    }
    const companyId = (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CASH_READ, companyId);
    const balance = await defaultCashRegisterService.getBalance(companyId, id);
    res.json({ status: 'ok', balance });
  })
);

// 7. Get Cash Register Movements
cashRoutes.get(
  '/registers/:id/movements',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف الصندوق غير صالح');
    }
    const companyId = (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CASH_READ, companyId);
    const movements = await defaultCashRegisterService.listMovements(companyId, id);
    res.json({ status: 'ok', movements });
  })
);

// ============================================================================
// Employee Custodies (العهد النقدية للموظفين)
// ============================================================================

// WP-3b: List Eligible Employees within the same company (placed before :id route)
cashRoutes.get(
  '/custodies/employees',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CUSTODY_REQUEST, companyId);
    const employees = await defaultCustodyService.listEligibleEmployees(companyId);
    res.json({ status: 'ok', employees });
  })
);

// List Custodies with optional filters
cashRoutes.get(
  '/custodies',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CASH_READ, companyId);

    const status = typeof req.query.status === 'string' && req.query.status ? (req.query.status as CustodyStatus) : undefined;
    const employeeUserId = typeof req.query.employeeUserId === 'string' && req.query.employeeUserId ? req.query.employeeUserId : undefined;
    const registerId = typeof req.query.registerId === 'string' && req.query.registerId ? req.query.registerId : undefined;
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined;

    const custodies = await defaultCustodyService.listCustodies(companyId, {
      status,
      employeeUserId,
      registerId,
      from,
      to,
    });
    res.json({ status: 'ok', custodies });
  })
);

// Get Single Custody
cashRoutes.get(
  '/custodies/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }
    const companyId = (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CASH_READ, companyId);
    const custody = await defaultCustodyService.getCustody(companyId, id);
    res.json({ status: 'ok', custody });
  })
);

// Request New Custody
cashRoutes.post(
  '/custodies',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CUSTODY_REQUEST, companyId);
    const custody = await defaultCustodyService.requestCustody(companyId, req.body || {}, user.id);
    res.status(201).json({ status: 'ok', custody });
  })
);

// Approve Custody
cashRoutes.post(
  '/custodies/:id/approve',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CUSTODY_APPROVE, companyId);
    const custody = await defaultCustodyService.approveCustody(
      companyId,
      id,
      user.id,
      user.role === 'platform_admin'
    );
    res.json({ status: 'ok', custody });
  })
);

// Reject Custody
cashRoutes.post(
  '/custodies/:id/reject',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CUSTODY_APPROVE, companyId);
    const custody = await defaultCustodyService.rejectCustody(
      companyId,
      id,
      user.id,
      req.body?.reason || ''
    );
    res.json({ status: 'ok', custody });
  })
);

// Disburse Custody (Creates & Posts GL Journal Entry + Out Movement)
cashRoutes.post(
  '/custodies/:id/disburse',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CUSTODY_DISBURSE, companyId);
    const custody = await defaultCustodyService.disburseCustody(
      companyId,
      id,
      user.id,
      user.role === 'platform_admin'
    );
    res.json({ status: 'ok', custody });
  })
);

// Settle Custody (Strict Expense + Cash Return = Amount, Creates & Posts GL Journal Entry)
cashRoutes.post(
  '/custodies/:id/settle',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CUSTODY_SETTLE, companyId);
    const custody = await defaultCustodyService.settleCustody(
      companyId,
      id,
      req.body || {},
      user.id,
      user.role === 'platform_admin'
    );
    res.json({ status: 'ok', custody });
  })
);

// Cancel Custody
// القاعدة الصريحة: يتطلب المسار صلاحية CUSTODY_REQUEST لإلغاء طلب pending،
// بينما يتطلب إلغاء عهدة معتمدة (approved) وجود صلاحية CUSTODY_APPROVE.
cashRoutes.post(
  '/custodies/:id/cancel',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    if (!companyId || !isUuid(companyId)) {
      throw new ValidationError('Invalid or missing company ID format');
    }
    const company = await defaultCompanyStore.getById(companyId);
    if (!company) {
      throw new NotFoundError('Company not found');
    }
    const canApprove = await defaultRbacService.hasPermission(user, PERMISSIONS.CUSTODY_APPROVE, companyId);
    const canRequest = canApprove
      ? true
      : await defaultRbacService.hasPermission(user, PERMISSIONS.CUSTODY_REQUEST, companyId);
    if (!canRequest && !canApprove) {
      throw new ForbiddenError(`Access denied: Missing required permission '${PERMISSIONS.CUSTODY_REQUEST}' for this company`);
    }
    const custody = await defaultCustodyService.cancelCustody(
      companyId,
      id,
      user.id,
      req.body?.reason ?? null,
      { canCancelApproved: canApprove }
    );
    res.json({ status: 'ok', custody });
  })
);

// Get Custody Movements
cashRoutes.get(
  '/custodies/:id/movements',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }
    const companyId = (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CASH_READ, companyId);
    const movements = await defaultCustodyService.listCustodyMovements(companyId, id);
    res.json({ status: 'ok', movements });
  })
);

// Open Custodies Summary Report
cashRoutes.get(
  '/reports/open-custodies',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertCashPermission(user, PERMISSIONS.CASH_READ, companyId);
    const employeeUserId =
      typeof req.query.employeeUserId === 'string' && req.query.employeeUserId
        ? req.query.employeeUserId
        : undefined;
    const summary = await defaultCustodyService.getOpenBalancesByEmployee(companyId, employeeUserId);
    res.json({ status: 'ok', summary });
  })
);

