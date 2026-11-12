import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultConfigService } from '../config-platform/configService.js';
import { wrap } from '../http/asyncHandler.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { requirePlatformAdmin } from '../rbac/requirePlatformAdmin.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { findGlEvent } from '../accounting/glEventCatalog.js';
import { defaultGlMappingService } from '../accounting/glMappingService.js';

/**
 * Configuration Platform read surface (Wave A / A2).
 * Reads are company-scoped and RLS-backed; writes follow Draft → Publish (A3/A4).
 * Permission model reuses company settings permissions (No-Demolition principle).
 */

function assertCompanyParam(req: AuthenticatedRequest): string {
  const { companyId } = req.params;
  if (!companyId || !isUuid(companyId)) {
    throw new ValidationError('Invalid company ID format');
  }
  return companyId;
}

// ---- Company-scoped configuration routes (mounted under /api/companies/:companyId) ----
export const companyConfigRoutes = Router({ mergeParams: true });

// GET /api/companies/:companyId/config — active published configs (or platform defaults)
companyConfigRoutes.get(
  '/config',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const configs = await defaultConfigService.listActiveConfigs(companyId);
    return res.status(200).json({ status: 'ok', configs });
  })
);

// GET /api/companies/:companyId/config/resolve?key=accounting.grn_mapping — resolution order
companyConfigRoutes.get(
  '/config/resolve',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const key = String(req.query.key || '');
    const resolved = await defaultConfigService.resolveConfig(companyId, key);
    return res.status(200).json({ status: 'ok', resolved });
  })
);

// GET /api/companies/:companyId/config/versions?key=... — immutable audit history
companyConfigRoutes.get(
  '/config/versions',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const key = String(req.query.key || '');
    const versions = await defaultConfigService.listVersions(companyId, key);
    return res.status(200).json({ status: 'ok', versions });
  })
);

// GET /api/companies/:companyId/config/draft?key=... — current draft (or default view)
companyConfigRoutes.get(
  '/config/draft',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const key = String(req.query.key || '');
    const draft = await defaultConfigService.getDraft(companyId, key);
    return res.status(200).json({ status: 'ok', draft });
  })
);

// PUT /api/companies/:companyId/config/draft — save draft (A4 structural validation on save)
companyConfigRoutes.put(
  '/config/draft',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const key = String(req.query.key || (req.body && req.body.key) || '');
    const actorId = req.user!.id;
    const draft = await defaultConfigService.saveDraft(companyId, key, req.body, actorId);
    return res.status(200).json({ status: 'ok', draft });
  })
);

// POST /api/companies/:companyId/config/publish — Draft → immutable version (A3 + A4 gates)
companyConfigRoutes.post(
  '/config/publish',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const key = String(req.query.key || (req.body && req.body.key) || '');
    const actorId = req.user!.id;
    const published = await defaultConfigService.publishDraft(companyId, key, req.body, actorId);
    return res.status(200).json({ status: 'ok', published });
  })
);

// POST /api/companies/:companyId/config/rollback — publish a copy of a known good version
companyConfigRoutes.post(
  '/config/rollback',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const key = String(req.query.key || (req.body && req.body.key) || '');
    const actorId = req.user!.id;
    const published = await defaultConfigService.rollback(companyId, key, req.body, actorId);
    return res.status(200).json({ status: 'ok', published });
  })
);

// POST /api/companies/:companyId/config/validate — dry-run validation, no writes
companyConfigRoutes.post(
  '/config/validate',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const key = String(req.query.key || (req.body && req.body.key) || '');
    const content = req.body && req.body.content;
    const result = await defaultConfigService.validateContent(companyId, key, content);
    return res.status(200).json({ status: 'ok', ...result });
  })
);

// GET /api/companies/:companyId/gl-events/:eventKey/resolve — resolve wired GL mapping event
companyConfigRoutes.get(
  '/gl-events/:eventKey/resolve',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const eventKey = String(req.params.eventKey || '');
    const resolved = await defaultGlMappingService.resolve(companyId, eventKey);
    return res.status(200).json({ status: 'ok', resolved });
  })
);

// POST /api/companies/:companyId/gl-events/:eventKey/validate — dry-run validation via ConfigService, rejects not_implemented with 400
companyConfigRoutes.post(
  '/gl-events/:eventKey/validate',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const eventKey = String(req.params.eventKey || '');
    const def = findGlEvent(eventKey);
    if (!def) {
      throw new NotFoundError(`حدث ربط محاسبي غير معروف: ${eventKey}`);
    }
    if (def.status !== 'wired') {
      throw new ValidationError(
        `حدث «${def.labelAr}» لسه بلا مسار ترحيل محاسبي في هذه النسخة — `
        + `الإعداد غير قابل للاستخدام حتى تُنفَّذ دورة الترحيل الخاصة به`
      );
    }
    const content = req.body && req.body.content;
    const result = await defaultConfigService.validateContent(companyId, eventKey, content);
    return res.status(200).json({ status: 'ok', ...result });
  })
);

// ---- Global definitions catalog (mounted under /api/config) ----
export const configPlatformRoutes = Router();

// GET /api/config/definitions — global customization-point catalog
configPlatformRoutes.get(
  '/definitions',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_READ),
  wrap(async (_req: AuthenticatedRequest, res: Response) => {
    const definitions = await defaultConfigService.listDefinitions();
    return res.status(200).json({ status: 'ok', definitions });
  })
);

// POST /api/config/definitions — create definition (platform_admin only)
configPlatformRoutes.post(
  '/definitions',
  requireAuth,
  requirePlatformAdmin,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const def = await defaultConfigService.createDefinition(req.body, req.user!.id);
    return res.status(201).json({ status: 'ok', definition: def });
  })
);

// PATCH /api/config/definitions/:key — update metadata only (platform_admin only)
configPlatformRoutes.patch(
  '/definitions/:key',
  requireAuth,
  requirePlatformAdmin,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const def = await defaultConfigService.updateDefinitionMeta(String(req.params.key), req.body, req.user!.id);
    return res.status(200).json({ status: 'ok', definition: def });
  })
);
