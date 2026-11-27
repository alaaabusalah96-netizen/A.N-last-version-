import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultAccountService } from '../accounting/accountService.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { defaultReportsService } from '../accounting/reportsService.js';
import { defaultYearCloseService } from '../accounting/yearCloseService.js';
import { defaultOperationalReportsService } from '../accounting/operationalReportsService.js';
import { buildReservedRoleResolver } from '../accounting/reservedRoleAccounts.js';
import { assertMaxDocumentLines } from '../http/documentLimits.js';
import { GL_EVENT_CATALOG } from '../accounting/glEventCatalog.js';

export const accountingRoutes = Router();

async function assertPermissionForCompanyQueryOrBody(
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

// GET /api/accounting/accounts?companyId=...
accountingRoutes.get(
  '/accounts',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_ACCOUNTS_READ, companyId);

    const listed = await defaultAccountService.listAccounts(companyId);
    // reservedRole: the system role that owns the account (null if free). Pickers for cash boxes and banks hide these.
    const resolveRole = await buildReservedRoleResolver(companyId);
    const accounts = listed.map((a: any) => ({ ...a, reservedRole: resolveRole(a) }));
    return res.status(200).json({ status: 'ok', accounts });
  })
);

// POST /api/accounting/accounts — Create account
accountingRoutes.post(
  '/accounts',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { companyId, code, nameAr, nameEn, accountType, parentId, isPostable } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_ACCOUNTS_CREATE, companyId);

    const account = await defaultAccountService.createAccount(
      companyId,
      { code, nameAr, nameEn, accountType, parentId, isPostable },
      user.id
    );

    return res.status(201).json({ status: 'ok', account });
  })
);

// POST /api/accounting/accounts/seed-default — Seed standard COA
accountingRoutes.post(
  '/accounts/seed-default',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { companyId } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_ACCOUNTS_SEED, companyId);

    const result = await defaultAccountService.seedDefaultCoa(companyId);
    return res.status(200).json({
      status: 'ok',
      createdCount: result.createdCount,
      accounts: result.accounts,
    });
  })
);

// ==========================================
// Journal Entries Endpoints (Ledger Guarantees)
// ==========================================

// GET /api/accounting/journals?companyId=...&orgUnitId=...
accountingRoutes.get(
  '/journals',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const orgUnitId = (req.query.orgUnitId as string) || undefined;

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);

    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const { defaultJournalService } = await import('../accounting/journalService.js');
    const journals = await defaultJournalService.listEntries(
      companyId,
      limit,
      offset,
      orgUnitId,
      user.id,
      user.role === 'platform_admin'
    );
    return res.status(200).json({ status: 'ok', journals });
  })
);

// GET /api/accounting/journals/org-units?companyId=...
// Org units the caller may use on the journal screen (works with journals.read, no org:units:read needed).
accountingRoutes.get(
  '/journals/org-units',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);
    const { defaultOrgUnitService } = await import('../org/orgUnitService.js');
    const units = await defaultOrgUnitService.listAccessibleUnits(companyId, user.id, user.role === 'platform_admin');
    return res.status(200).json({ status: 'ok', units });
  })
);

// GET /api/accounting/journals/:id?companyId=...
accountingRoutes.get(
  '/journals/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    const companyId = (req.query.companyId as string) || '';

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);

    const { defaultJournalService } = await import('../accounting/journalService.js');
    const journal = await defaultJournalService.getEntry(
      companyId,
      id,
      user.id,
      user.role === 'platform_admin'
    );
    if (!journal) {
      throw new NotFoundError('Journal entry not found');
    }
    return res.status(200).json({ status: 'ok', journal });
  })
);

// POST /api/accounting/journals — Create draft journal entry
accountingRoutes.post(
  '/journals',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { companyId, entryDate, memo, orgUnitId, lines } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_WRITE, companyId);
    assertMaxDocumentLines(lines);

    const { defaultJournalService } = await import('../accounting/journalService.js');
    const journal = await defaultJournalService.createDraftEntry(
      companyId,
      { entryDate, memo, orgUnitId, lines },
      user.id,
      user.role === 'platform_admin'
    );
    return res.status(201).json({ status: 'ok', journal });
  })
);

// POST /api/accounting/journals/:id/post — Post balanced journal entry
accountingRoutes.post(
  '/journals/:id/post',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    const { companyId } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_POST, companyId);

    const { defaultJournalService } = await import('../accounting/journalService.js');
    const journal = await defaultJournalService.postEntry(
      companyId,
      id,
      user.id,
      user.role === 'platform_admin'
    );
    return res.status(200).json({ status: 'ok', journal });
  })
);

// POST /api/accounting/journals/:id/reverse — Reverse posted journal entry
accountingRoutes.post(
  '/journals/:id/reverse',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    const { companyId, reversalMemo } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_POST, companyId);

    const { defaultJournalService } = await import('../accounting/journalService.js');
    const reversal = await defaultJournalService.reverseEntry(
      companyId,
      id,
      user.id,
      reversalMemo,
      user.role === 'platform_admin'
    );
    return res.status(200).json({ status: 'ok', reversal });
  })
);

// ==========================================
// Trial Balance Endpoints
// ==========================================

// GET /api/accounting/trial-balance?companyId=...&asOfDate=...&orgUnitId=...
accountingRoutes.get(
  '/trial-balance',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const asOfDate = (req.query.asOfDate as string) || undefined;
    const orgUnitId = (req.query.orgUnitId as string) || undefined;

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);

    const { defaultTrialBalanceService } = await import('../accounting/trialBalanceService.js');
    const summary = await defaultTrialBalanceService.getTrialBalance(
      companyId,
      { asOfDate, orgUnitId },
      user.id,
      user.role === 'platform_admin'
    );
    return res.status(200).json({ status: 'ok', summary });
  })
);

// ==========================================
// Accounting Periods Endpoints
// ==========================================

// GET /api/accounting/periods?companyId=...
accountingRoutes.get(
  '/periods',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);

    const { defaultPeriodService } = await import('../accounting/periodService.js');
    const periods = await defaultPeriodService.listPeriods(companyId);
    return res.status(200).json({ status: 'ok', periods });
  })
);

// POST /api/accounting/periods — Create period
accountingRoutes.post(
  '/periods',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { companyId, code, startDate, endDate } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_POST, companyId);

    const { defaultPeriodService } = await import('../accounting/periodService.js');
    const period = await defaultPeriodService.createPeriod(
      companyId,
      { code, startDate, endDate },
      user.id
    );
    return res.status(201).json({ status: 'ok', period });
  })
);

// POST /api/accounting/periods/:id/close — Close an open period
accountingRoutes.post(
  '/periods/:id/close',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    const { companyId } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_POST, companyId);

    const { defaultPeriodService } = await import('../accounting/periodService.js');
    const period = await defaultPeriodService.closePeriod(companyId, id, user.id);
    return res.status(200).json({ status: 'ok', period });
  })
);

// POST /api/accounting/periods/:id/reopen — Reopen a closed period
accountingRoutes.post(
  '/periods/:id/reopen',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    const { companyId } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_POST, companyId);

    const { defaultPeriodService } = await import('../accounting/periodService.js');
    const period = await defaultPeriodService.reopenPeriod(companyId, id, user.id);
    return res.status(200).json({ status: 'ok', period });
  })
);

// GET /api/accounting/reports/general-ledger?companyId=&accountId=&fromDate=&toDate=
accountingRoutes.get(
  '/reports/general-ledger',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const accountId = (req.query.accountId as string) || '';
    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);
    const report = await defaultReportsService.getGeneralLedger(companyId, accountId, {
      fromDate: (req.query.fromDate as string) || undefined,
      toDate: (req.query.toDate as string) || undefined,
    });
    return res.status(200).json({ status: 'ok', report });
  })
);

// GET /api/accounting/reports/income-statement?companyId=&fromDate=&toDate=
accountingRoutes.get(
  '/reports/income-statement',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);
    const report = await defaultReportsService.getIncomeStatement(companyId, {
      fromDate: (req.query.fromDate as string) || undefined,
      toDate: (req.query.toDate as string) || undefined,
    });
    return res.status(200).json({ status: 'ok', report });
  })
);

// GET /api/accounting/reports/balance-sheet?companyId=&asOfDate=
accountingRoutes.get(
  '/reports/balance-sheet',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);
    const report = await defaultReportsService.getBalanceSheet(companyId, {
      asOfDate: (req.query.asOfDate as string) || undefined,
    });
    return res.status(200).json({ status: 'ok', report });
  })
);

// ==========================================
// Operational Reports Endpoints (AN-REPORTS-OPS-1)
// ==========================================

// GET /api/accounting/reports/ops-cash-summary?companyId=
accountingRoutes.get(
  '/reports/ops-cash-summary',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);
    const report = await defaultOperationalReportsService.getCashAndBankSummary(companyId);
    return res.status(200).json({ status: 'ok', report });
  })
);

// GET /api/accounting/reports/ops-ar-ap-aging?companyId=
accountingRoutes.get(
  '/reports/ops-ar-ap-aging',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);
    const report = await defaultOperationalReportsService.getArApAgingSummary(companyId);
    return res.status(200).json({ status: 'ok', report });
  })
);

// ==========================================
// Fiscal Year Close Endpoints (AN-YEAR-CLOSE-1)
// ==========================================

// GET /api/accounting/year-close?companyId=...
accountingRoutes.get(
  '/year-close',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);
    const closes = await defaultYearCloseService.listYearCloses(companyId);
    return res.status(200).json({ status: 'ok', closes });
  })
);

// POST /api/accounting/year-close/preview
accountingRoutes.post(
  '/year-close/preview',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { companyId, fiscalYearCode, startDate, endDate } = req.body || {};
    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId || '');
    const preview = await defaultYearCloseService.previewYearClose(companyId, {
      fiscalYearCode,
      startDate,
      endDate,
    });
    return res.status(200).json({ status: 'ok', preview });
  })
);

// POST /api/accounting/year-close/execute
accountingRoutes.post(
  '/year-close/execute',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { companyId, fiscalYearCode, startDate, endDate, retainedEarningsAccountId, notes } = req.body || {};
    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_POST, companyId || '');
    const yearClose = await defaultYearCloseService.executeYearClose(
      companyId,
      {
        fiscalYearCode,
        startDate,
        endDate,
        retainedEarningsAccountId,
        notes,
      },
      user.id,
      user.role === 'platform_admin'
    );
    return res.status(201).json({ status: 'ok', yearClose });
  })
);

// ==========================================
// GL Mapping Events Catalog (B5)
// ==========================================

// GET /api/accounting/gl-events
accountingRoutes.get(
  '/gl-events',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId.trim() : '';

    if (companyId) {
      await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_ACCOUNTS_READ, companyId);
    } else {
      const allowed = await defaultRbacService.hasPermission(user, PERMISSIONS.ACCOUNTING_ACCOUNTS_READ);
      if (!allowed) {
        throw new ForbiddenError(`Access denied: Missing required permission '${PERMISSIONS.ACCOUNTING_ACCOUNTS_READ}'`);
      }
    }

    const events = GL_EVENT_CATALOG.map((e) => ({
      eventKey: e.eventKey,
      eventCode: e.eventCode,
      labelAr: e.labelAr,
      status: e.status,
      wiringPoint: e.wiringPoint,
      fields: e.fields,
    }));
    return res.status(200).json({ status: 'ok', events });
  })
);

