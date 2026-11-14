import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultCashRegisterService } from '../cash/cashRegisterService.js';
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
