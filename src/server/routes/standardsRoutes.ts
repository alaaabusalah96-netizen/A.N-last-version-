import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { requirePlatformAdmin } from '../rbac/requirePlatformAdmin.js';
import { defaultStandardsService } from '../standards/standardsService.js';

export const standardsRoutes = Router();

async function assertPermission(user: AuthenticatedRequest['user'], permission: string, companyId: string): Promise<void> {
  if (!companyId || !isUuid(companyId)) throw new ValidationError('Invalid or missing company ID format');
  const company = await defaultCompanyStore.getById(companyId);
  if (!company) throw new NotFoundError('Company not found');
  const allowed = await defaultRbacService.hasPermission(user!, permission, companyId);
  if (!allowed) throw new ForbiddenError('ليس لديك صلاحية لتنفيذ هذه العملية');
}
const cid = (req: AuthenticatedRequest) => ((req.body?.companyId as string) || (req.query.companyId as string) || '');
const today = () => new Date().toISOString().slice(0, 10);

// GET /api/standards/frameworks
standardsRoutes.get('/frameworks', requireAuth, wrap(async (_req: AuthenticatedRequest, res: Response) => {
  return res.status(200).json({ status: 'ok', frameworks: await defaultStandardsService.listFrameworks() });
}));

// GET /api/standards/profile?companyId=&date=: the company's framework + country on a date (default today), plus history
standardsRoutes.get('/profile', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertPermission(req.user, PERMISSIONS.COMPANY_SETTINGS_READ, companyId);
  const date = (req.query.date as string) || today();
  const [current, history] = await Promise.all([defaultStandardsService.getProfileOn(companyId, date), defaultStandardsService.listProfileHistory(companyId)]);
  return res.status(200).json({ status: 'ok', date, current, history });
}));

// PUT /api/standards/profile: append a new profile effective from a date
standardsRoutes.put('/profile', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertPermission(req.user, PERMISSIONS.COMPANY_SETTINGS_WRITE, companyId);
  const { frameworkCode, countryCode, validFrom, note } = req.body || {};
  const profile = await defaultStandardsService.setProfile(companyId, { frameworkCode, countryCode, validFrom, note }, req.user!.id);
  return res.status(200).json({ status: 'ok', profile });
}));

// GET /api/standards/policies?policyKey=&frameworkCode=
standardsRoutes.get('/policies', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  return res.status(200).json({ status: 'ok', policies: await defaultStandardsService.listPolicies({ policyKey: req.query.policyKey as string, frameworkCode: req.query.frameworkCode as string }) });
}));

// POST /api/standards/policies: platform admin appends a policy version
standardsRoutes.post('/policies', requireAuth, requirePlatformAdmin, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const policy = await defaultStandardsService.createPolicyVersion({ id: req.user!.id, role: req.user!.role }, req.body || {});
  return res.status(201).json({ status: 'ok', policy });
}));

// GET /api/standards/resolve?companyId=&policyKey=&date=
standardsRoutes.get('/resolve', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertPermission(req.user, PERMISSIONS.COMPANY_SETTINGS_READ, companyId);
  const policyKey = (req.query.policyKey as string) || '';
  if (!policyKey) throw new ValidationError('policyKey مطلوب');
  return res.status(200).json({ status: 'ok', result: await defaultStandardsService.resolvePolicy(companyId, policyKey, (req.query.date as string) || today()) });
}));

// POST /api/standards/dataset: platform admin loads an official-standards dataset (additive; ACTIVE only for verified rows)
standardsRoutes.post('/dataset', requireAuth, requirePlatformAdmin, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const rows = req.body?.rows;
  if (!Array.isArray(rows)) throw new ValidationError('rows مطلوبة (مصفوفة)');
  if (rows.length > 500) throw new ValidationError('الحد الأقصى 500 صف في التحميل الواحد');
  return res.status(200).json({ status: 'ok', result: await defaultStandardsService.loadDataset({ id: req.user!.id, role: req.user!.role }, rows, { datasetVersion: typeof req.body?.datasetVersion === 'string' ? req.body.datasetVersion : undefined, note: typeof req.body?.note === 'string' ? req.body.note : undefined }) });
}));
