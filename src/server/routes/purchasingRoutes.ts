import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultSupplierService } from '../purchasing/supplierService.js';
import { defaultGrnService } from '../purchasing/grnService.js';
import { defaultPurchaseOrderService } from '../purchasing/purchaseOrderService.js';
import { defaultInvoiceService } from '../purchasing/invoiceService.js';
import { defaultPriceVarianceExceptionService } from '../purchasing/priceVarianceExceptionService.js';
import { defaultThreeWayMatchService } from '../purchasing/threeWayMatchService.js';
import { defaultPurchReturnService } from '../purchasing/purchReturnService.js';
import { defaultApOpenItemsService } from '../purchasing/apOpenItemsService.js';
import { defaultSupplierPaymentService } from '../purchasing/supplierPaymentService.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';

export const purchasingRoutes = Router();

async function assertPurchasingPermission(
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

function resolveMutationCompanyId(req: AuthenticatedRequest): string {
  const bodyCompanyId = typeof req.body?.companyId === 'string' ? req.body.companyId.trim() : '';
  const queryCompanyId = typeof req.query?.companyId === 'string' ? req.query.companyId.trim() : '';
  if (bodyCompanyId && queryCompanyId && bodyCompanyId !== queryCompanyId) {
    throw new ValidationError('Company ID in request body does not match query parameter');
  }
  return bodyCompanyId || queryCompanyId;
}

// 1. Suppliers API
purchasingRoutes.get(
  '/suppliers',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);

    const suppliers = await defaultSupplierService.listSuppliers(companyId);
    return res.status(200).json({ status: 'ok', suppliers });
  })
);

purchasingRoutes.post(
  '/suppliers',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_WRITE, companyId);

    const { code, nameAr, nameEn } = req.body;
    const supplier = await defaultSupplierService.createSupplier(
      companyId,
      { code, nameAr, nameEn },
      user.id
    );

    return res.status(201).json({ status: 'ok', supplier });
  })
);

// 2. Goods Receipt Notes (GRN) API
purchasingRoutes.get(
  '/grn',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);

    const grns = await defaultGrnService.listGrns(companyId);
    return res.status(200).json({ status: 'ok', grns });
  })
);

purchasingRoutes.get(
  '/grn/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const grnId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);

    const grn = await defaultGrnService.getGrn(companyId, grnId);
    return res.status(200).json({ status: 'ok', grn });
  })
);

purchasingRoutes.post(
  '/grn',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_WRITE, companyId);

    const { supplierId, warehouseId, memo, lines } = req.body;
    const grn = await defaultGrnService.createGrn(
      companyId,
      { supplierId, warehouseId, memo, lines },
      user.id
    );

    return res.status(201).json({ status: 'ok', grn });
  })
);

purchasingRoutes.post(
  '/grn/:id/post',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const grnId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_POST, companyId);

    const grn = await defaultGrnService.postGrn(companyId, grnId, user.id);

    return res.status(200).json({ status: 'ok', grn });
  })
);

// 3. Purchase Orders (PO) API
purchasingRoutes.get(
  '/purchase-orders',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);

    const purchaseOrders = await defaultPurchaseOrderService.listPurchaseOrders(companyId);
    return res.status(200).json({ status: 'ok', purchaseOrders });
  })
);

purchasingRoutes.get(
  '/purchase-orders/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const poId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    if (!isUuid(poId)) {
      throw new ValidationError('Invalid purchase order ID format');
    }

    const purchaseOrder = await defaultPurchaseOrderService.getPurchaseOrder(companyId, poId);
    return res.status(200).json({ status: 'ok', purchaseOrder });
  })
);

purchasingRoutes.get(
  '/purchase-orders/:id/remaining',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const poId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    if (!isUuid(poId)) {
      throw new ValidationError('Invalid purchase order ID format');
    }

    const purchaseOrder = await defaultPurchaseOrderService.getPurchaseOrder(companyId, poId);
    const linesWithRemaining = (purchaseOrder.lines || []).map((l) => ({
      ...l,
      remainingQty: Math.max(0, Number(l.qty) - Number(l.receivedQty || 0)),
    }));

    return res.status(200).json({
      status: 'ok',
      purchaseOrder,
      lines: linesWithRemaining,
    });
  })
);

purchasingRoutes.post(
  '/purchase-orders',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_WRITE, companyId);

    const { supplierId, expectedDate, memo, lines } = req.body || {};
    const purchaseOrder = await defaultPurchaseOrderService.createPurchaseOrder(
      companyId,
      { supplierId, expectedDate, memo, lines },
      user.id
    );

    return res.status(201).json({ status: 'ok', purchaseOrder });
  })
);

purchasingRoutes.post(
  '/purchase-orders/:id/approve',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const poId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_POST, companyId);
    if (!isUuid(poId)) {
      throw new ValidationError('Invalid purchase order ID format');
    }

    const purchaseOrder = await defaultPurchaseOrderService.approvePurchaseOrder(companyId, poId, user.id);
    return res.status(200).json({ status: 'ok', purchaseOrder });
  })
);

purchasingRoutes.post(
  '/purchase-orders/:id/close',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const poId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_POST, companyId);
    if (!isUuid(poId)) {
      throw new ValidationError('Invalid purchase order ID format');
    }

    const purchaseOrder = await defaultPurchaseOrderService.closePurchaseOrder(companyId, poId, user.id);
    return res.status(200).json({ status: 'ok', purchaseOrder });
  })
);

purchasingRoutes.post(
  '/purchase-orders/:id/cancel',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const poId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_POST, companyId);
    if (!isUuid(poId)) {
      throw new ValidationError('Invalid purchase order ID format');
    }

    const purchaseOrder = await defaultPurchaseOrderService.cancelPurchaseOrder(companyId, poId, user.id);
    return res.status(200).json({ status: 'ok', purchaseOrder });
  })
);

// 4. Supplier Invoices (AP) API
purchasingRoutes.get(
  '/supplier-invoices',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);

    const invoices = await defaultInvoiceService.listInvoices(companyId);
    return res.status(200).json({ status: 'ok', invoices });
  })
);

purchasingRoutes.get(
  '/supplier-invoices/outstanding',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const supplierId = (req.query.supplierId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    if (!isUuid(supplierId)) {
      throw new ValidationError('Invalid supplier ID format');
    }

    const outstandingLines = await defaultInvoiceService.getOutstandingLines(companyId, supplierId);
    return res.status(200).json({ status: 'ok', outstandingLines });
  })
);

purchasingRoutes.get(
  '/supplier-invoices/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const invoiceId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    if (!isUuid(invoiceId)) {
      throw new ValidationError('Invalid invoice ID format');
    }

    const invoice = await defaultInvoiceService.getInvoice(companyId, invoiceId);
    return res.status(200).json({ status: 'ok', invoice });
  })
);

purchasingRoutes.post(
  '/supplier-invoices',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_WRITE, companyId);

    const { supplierId, supplierInvoiceNo, invoiceDate, dueDate, memo, lines } = req.body || {};
    const invoice = await defaultInvoiceService.createInvoice(
      companyId,
      { supplierId, supplierInvoiceNo, invoiceDate, dueDate, memo, lines },
      user.id
    );

    return res.status(201).json({ status: 'ok', invoice });
  })
);

purchasingRoutes.post(
  '/supplier-invoices/:id/post',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const invoiceId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_POST, companyId);
    if (!isUuid(invoiceId)) {
      throw new ValidationError('Invalid invoice ID format');
    }

    const invoice = await defaultInvoiceService.postInvoice(companyId, invoiceId, user.id);
    return res.status(200).json({ status: 'ok', invoice });
  })
);

purchasingRoutes.delete(
  '/supplier-invoices/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const invoiceId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_WRITE, companyId);
    if (!isUuid(invoiceId)) {
      throw new ValidationError('Invalid invoice ID format');
    }

    await defaultInvoiceService.deleteInvoice(companyId, invoiceId, user.id);
    return res.status(200).json({ status: 'ok', deleted: true });
  })
);

purchasingRoutes.post(
  '/supplier-invoices/:id/price-exceptions',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = resolveMutationCompanyId(req);
    const invoiceId = req.params.id;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_VARIANCE_REQUEST, companyId);
    if (!user?.id) {
      throw new ValidationError('Authenticated user ID is required');
    }
    if (!isUuid(invoiceId)) {
      throw new ValidationError('Invalid invoice ID format');
    }
    const { reason } = req.body || {};
    const exception = await defaultPriceVarianceExceptionService.requestException(companyId, invoiceId, reason, user.id);
    return res.status(201).json({ status: 'ok', exception });
  })
);

purchasingRoutes.get(
  '/supplier-invoices/:id/price-exceptions',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const invoiceId = req.params.id;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    if (!isUuid(invoiceId)) {
      throw new ValidationError('Invalid invoice ID format');
    }
    const exceptions = await defaultPriceVarianceExceptionService.listExceptions(companyId, invoiceId);
    return res.status(200).json({ status: 'ok', exceptions });
  })
);

purchasingRoutes.post(
  '/price-exceptions/:id/approve',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = resolveMutationCompanyId(req);
    const exceptionId = req.params.id;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_VARIANCE_APPROVE, companyId);
    if (!user?.id) {
      throw new ValidationError('Authenticated user ID is required');
    }
    if (!isUuid(exceptionId)) {
      throw new ValidationError('Invalid exception ID format');
    }
    const { decisionReason } = req.body || {};
    const exception = await defaultPriceVarianceExceptionService.approveException(companyId, exceptionId, decisionReason, user.id);
    return res.status(200).json({ status: 'ok', exception });
  })
);

purchasingRoutes.post(
  '/price-exceptions/:id/reject',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = resolveMutationCompanyId(req);
    const exceptionId = req.params.id;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_VARIANCE_APPROVE, companyId);
    if (!user?.id) {
      throw new ValidationError('Authenticated user ID is required');
    }
    if (!isUuid(exceptionId)) {
      throw new ValidationError('Invalid exception ID format');
    }
    const { decisionReason } = req.body || {};
    const exception = await defaultPriceVarianceExceptionService.rejectException(companyId, exceptionId, decisionReason, user.id);
    return res.status(200).json({ status: 'ok', exception });
  })
);

// 5. 3-Way Matching API
purchasingRoutes.get(
  '/three-way-match/policy',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    const policy = defaultThreeWayMatchService.getPolicy();
    return res.status(200).json({ status: 'ok', policy });
  })
);

purchasingRoutes.get(
  '/supplier-invoices/:id/three-way-match',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const invoiceId = req.params.id;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    if (!isUuid(invoiceId)) {
      throw new ValidationError('Invalid invoice ID format');
    }
    const report = await defaultThreeWayMatchService.evaluateInvoice(companyId, invoiceId);
    return res.status(200).json({ status: 'ok', report });
  })
);

// 6. Purchase Returns API
purchasingRoutes.get(
  '/returns',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    const returns = await defaultPurchReturnService.listReturns(companyId);
    return res.status(200).json({ status: 'ok', returns });
  })
);

purchasingRoutes.get(
  '/returns/returnable',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const supplierId = (req.query.supplierId as string) || undefined;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    const returnableLines = await defaultPurchReturnService.listReturnableLines(companyId, supplierId);
    return res.status(200).json({ status: 'ok', returnableLines });
  })
);

purchasingRoutes.get(
  '/returns/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const returnId = req.params.id;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    if (!isUuid(returnId)) {
      throw new ValidationError('Invalid return ID format');
    }
    const purchaseReturn = await defaultPurchReturnService.getReturn(companyId, returnId);
    return res.status(200).json({ status: 'ok', purchaseReturn });
  })
);

purchasingRoutes.post(
  '/returns',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_WRITE, companyId);
    const { supplierId, warehouseId, grnId, invoiceId, returnDate, reason, memo, lines } = req.body || {};
    const purchaseReturn = await defaultPurchReturnService.createReturn(
      companyId,
      { supplierId, warehouseId, grnId, invoiceId, returnDate, reason, memo, lines },
      user.id
    );
    return res.status(201).json({ status: 'ok', purchaseReturn });
  })
);

purchasingRoutes.post(
  '/returns/:id/post',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const returnId = req.params.id;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_POST, companyId);
    if (!isUuid(returnId)) {
      throw new ValidationError('Invalid return ID format');
    }
    const purchaseReturn = await defaultPurchReturnService.postReturn(companyId, returnId, user.id);
    return res.status(200).json({ status: 'ok', purchaseReturn });
  })
);

purchasingRoutes.delete(
  '/returns/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const returnId = req.params.id;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_WRITE, companyId);
    if (!isUuid(returnId)) {
      throw new ValidationError('Invalid return ID format');
    }
    await defaultPurchReturnService.deleteReturn(companyId, returnId, user.id);
    return res.status(200).json({ status: 'ok', deleted: true });
  })
);

// 7. AP Open Items API
purchasingRoutes.get(
  '/ap/open-items',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const supplierId = (req.query.supplierId as string) || undefined;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    const openItems = await defaultApOpenItemsService.listOpenItems(companyId, supplierId);
    return res.status(200).json({ status: 'ok', openItems });
  })
);

// 8. Supplier Cash Payments API
purchasingRoutes.get(
  '/supplier-payments',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    const payments = await defaultSupplierPaymentService.listPayments(companyId);
    return res.status(200).json({ status: 'ok', payments });
  })
);

purchasingRoutes.get(
  '/supplier-payments/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const paymentId = req.params.id;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    if (!isUuid(paymentId)) {
      throw new ValidationError('Invalid payment ID format');
    }
    const payment = await defaultSupplierPaymentService.getPayment(companyId, paymentId);
    return res.status(200).json({ status: 'ok', payment });
  })
);

purchasingRoutes.post(
  '/supplier-payments',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_WRITE, companyId);
    const { supplierId, invoiceId, lines, registerId, paymentDate, amount, reference, memo } = req.body || {};
    const payment = await defaultSupplierPaymentService.createPayment(
      companyId,
      { supplierId, invoiceId, lines, registerId, paymentDate, amount, reference, memo },
      user.id
    );
    return res.status(201).json({ status: 'ok', payment });
  })
);

purchasingRoutes.post(
  '/supplier-payments/:id/post',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const paymentId = req.params.id;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_POST, companyId);
    if (!isUuid(paymentId)) {
      throw new ValidationError('Invalid payment ID format');
    }
    const payment = await defaultSupplierPaymentService.postPayment(companyId, paymentId, user.id);
    return res.status(200).json({ status: 'ok', payment });
  })
);

purchasingRoutes.delete(
  '/supplier-payments/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const paymentId = req.params.id;
    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_WRITE, companyId);
    if (!isUuid(paymentId)) {
      throw new ValidationError('Invalid payment ID format');
    }
    await defaultSupplierPaymentService.cancelPayment(companyId, paymentId, user.id);
    return res.status(200).json({ status: 'ok', deleted: true });
  })
);
