import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultCustomerService } from '../sales/customerService.js';
import { defaultSalesDeliveryService } from '../sales/salesDeliveryService.js';
import { defaultSalesInvoiceService } from '../sales/salesInvoiceService.js';
import { defaultSalesCollectionService } from '../sales/salesCollectionService.js';
import { defaultSalesReturnService } from '../sales/salesReturnService.js';
import { defaultArAgingService } from '../sales/arAgingService.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';

export const salesRoutes = Router();

async function assertSalesPermission(
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

// 1. Customers API
salesRoutes.get(
  '/customers',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertSalesPermission(user, PERMISSIONS.SALES_READ, companyId);
    const customers = await defaultCustomerService.listCustomers(companyId);
    return res.status(200).json({ status: 'ok', customers });
  })
);

salesRoutes.get(
  '/customers/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_READ, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid customer ID format');
    const customer = await defaultCustomerService.getCustomer(companyId, id);
    return res.status(200).json({ status: 'ok', customer });
  })
);

salesRoutes.post(
  '/customers',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertSalesPermission(user, PERMISSIONS.SALES_WRITE, companyId);
    const { code, nameAr, nameEn, phone, email, taxNumber, address, creditLimit, isActive } = req.body || {};
    const customer = await defaultCustomerService.createCustomer(
      companyId,
      { code, nameAr, nameEn, phone, email, taxNumber, address, creditLimit, isActive },
      user.id
    );
    return res.status(201).json({ status: 'ok', customer });
  })
);

salesRoutes.put(
  '/customers/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_WRITE, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid customer ID format');
    const { nameAr, nameEn, phone, email, taxNumber, address, creditLimit, isActive } = req.body || {};
    const customer = await defaultCustomerService.updateCustomer(
      companyId,
      id,
      { nameAr, nameEn, phone, email, taxNumber, address, creditLimit, isActive },
      user.id
    );
    return res.status(200).json({ status: 'ok', customer });
  })
);

salesRoutes.delete(
  '/customers/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_WRITE, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid customer ID format');
    await defaultCustomerService.deleteCustomer(companyId, id, user.id);
    return res.status(200).json({ status: 'ok', deleted: true });
  })
);

// 2. Sales Delivery Notes API (Goods Issue)
salesRoutes.get(
  '/deliveries',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertSalesPermission(user, PERMISSIONS.SALES_READ, companyId);
    const deliveries = await defaultSalesDeliveryService.listDeliveries(companyId);
    return res.status(200).json({ status: 'ok', deliveries });
  })
);

salesRoutes.get(
  '/deliveries/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_READ, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid delivery ID format');
    const delivery = await defaultSalesDeliveryService.getDelivery(companyId, id);
    return res.status(200).json({ status: 'ok', delivery });
  })
);

salesRoutes.post(
  '/deliveries',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertSalesPermission(user, PERMISSIONS.SALES_WRITE, companyId);
    const { customerId, warehouseId, deliveryDate, memo, lines } = req.body || {};
    const delivery = await defaultSalesDeliveryService.createDelivery(
      companyId,
      { customerId, warehouseId, deliveryDate, memo, lines },
      user.id
    );
    return res.status(201).json({ status: 'ok', delivery });
  })
);

salesRoutes.post(
  '/deliveries/:id/post',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_POST, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid delivery ID format');
    const delivery = await defaultSalesDeliveryService.postDelivery(companyId, id, user.id);
    return res.status(200).json({ status: 'ok', delivery });
  })
);

salesRoutes.delete(
  '/deliveries/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_WRITE, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid delivery ID format');
    await defaultSalesDeliveryService.deleteDelivery(companyId, id, user.id);
    return res.status(200).json({ status: 'ok', deleted: true });
  })
);

// 3. Sales Invoices API (AR Invoices)
salesRoutes.get(
  '/invoices',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertSalesPermission(user, PERMISSIONS.SALES_READ, companyId);
    const invoices = await defaultSalesInvoiceService.listInvoices(companyId);
    return res.status(200).json({ status: 'ok', invoices });
  })
);

salesRoutes.get(
  '/invoices/outstanding',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const customerId = (req.query.customerId as string) || undefined;
    await assertSalesPermission(user, PERMISSIONS.SALES_READ, companyId);
    const outstandingInvoices = await defaultSalesInvoiceService.listOutstandingInvoices(companyId, customerId);
    return res.status(200).json({ status: 'ok', outstandingInvoices });
  })
);

salesRoutes.get(
  '/invoices/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_READ, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid invoice ID format');
    const invoice = await defaultSalesInvoiceService.getInvoice(companyId, id);
    return res.status(200).json({ status: 'ok', invoice });
  })
);

salesRoutes.post(
  '/invoices',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertSalesPermission(user, PERMISSIONS.SALES_WRITE, companyId);
    const { customerId, deliveryId, invoiceDate, dueDate, memo, lines } = req.body || {};
    const invoice = await defaultSalesInvoiceService.createInvoice(
      companyId,
      { customerId, deliveryId, invoiceDate, dueDate, memo, lines },
      user.id
    );
    return res.status(201).json({ status: 'ok', invoice });
  })
);

salesRoutes.post(
  '/invoices/:id/post',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_POST, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid invoice ID format');
    const invoice = await defaultSalesInvoiceService.postInvoice(companyId, id, user.id);
    return res.status(200).json({ status: 'ok', invoice });
  })
);

salesRoutes.post(
  '/invoices/:id/cancel',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_POST, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid invoice ID format');
    const reason = (req.body?.reason as string) || '';
    const invoice = await defaultSalesInvoiceService.cancelPostedInvoice(companyId, id, reason, user.id);
    return res.status(200).json({ status: 'ok', invoice });
  })
);

salesRoutes.delete(
  '/invoices/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_WRITE, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid invoice ID format');
    await defaultSalesInvoiceService.deleteInvoice(companyId, id, user.id);
    return res.status(200).json({ status: 'ok', deleted: true });
  })
);

// 4. Sales Collections API
salesRoutes.get(
  '/collections',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertSalesPermission(user, PERMISSIONS.SALES_READ, companyId);
    const collections = await defaultSalesCollectionService.listCollections(companyId);
    return res.status(200).json({ status: 'ok', collections });
  })
);

salesRoutes.get(
  '/collections/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_READ, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid collection ID format');
    const collection = await defaultSalesCollectionService.getCollection(companyId, id);
    return res.status(200).json({ status: 'ok', collection });
  })
);

salesRoutes.post(
  '/collections',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertSalesPermission(user, PERMISSIONS.SALES_WRITE, companyId);
    const { customerId, invoiceId, registerId, collectionDate, amount, reference, memo } = req.body || {};
    const collection = await defaultSalesCollectionService.createCollection(
      companyId,
      { customerId, invoiceId, registerId, collectionDate, amount, reference, memo },
      user.id
    );
    return res.status(201).json({ status: 'ok', collection });
  })
);

salesRoutes.post(
  '/collections/:id/post',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_POST, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid collection ID format');
    const collection = await defaultSalesCollectionService.postCollection(companyId, id, user.id);
    return res.status(200).json({ status: 'ok', collection });
  })
);

salesRoutes.delete(
  '/collections/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_WRITE, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid collection ID format');
    await defaultSalesCollectionService.deleteCollection(companyId, id, user.id);
    return res.status(200).json({ status: 'ok', deleted: true });
  })
);

// 5. Sales Returns API
salesRoutes.get(
  '/returns',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertSalesPermission(user, PERMISSIONS.SALES_READ, companyId);
    const returns = await defaultSalesReturnService.listReturns(companyId);
    return res.status(200).json({ status: 'ok', returns });
  })
);

salesRoutes.get(
  '/returns/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_READ, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid return ID format');
    const salesReturn = await defaultSalesReturnService.getReturn(companyId, id);
    return res.status(200).json({ status: 'ok', return: salesReturn });
  })
);

salesRoutes.post(
  '/returns',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertSalesPermission(user, PERMISSIONS.SALES_WRITE, companyId);
    const { customerId, invoiceId, warehouseId, returnDate, reason, memo, lines } = req.body || {};
    const salesReturn = await defaultSalesReturnService.createReturn(
      companyId,
      { customerId, invoiceId, warehouseId, returnDate, reason, memo, lines },
      user.id
    );
    return res.status(201).json({ status: 'ok', return: salesReturn });
  })
);

salesRoutes.post(
  '/returns/:id/post',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_POST, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid return ID format');
    const salesReturn = await defaultSalesReturnService.postReturn(companyId, id, user.id);
    return res.status(200).json({ status: 'ok', return: salesReturn });
  })
);

salesRoutes.delete(
  '/returns/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const id = req.params.id;
    await assertSalesPermission(user, PERMISSIONS.SALES_WRITE, companyId);
    if (!isUuid(id)) throw new ValidationError('Invalid return ID format');
    await defaultSalesReturnService.deleteReturn(companyId, id, user.id);
    return res.status(200).json({ status: 'ok', deleted: true });
  })
);

// 6. AR Aging Report API
salesRoutes.get(
  '/ar/aging',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertSalesPermission(user, PERMISSIONS.SALES_READ, companyId);
    const agingReport = await defaultArAgingService.getAgingReport(companyId);
    return res.status(200).json({ status: 'ok', agingReport });
  })
);
