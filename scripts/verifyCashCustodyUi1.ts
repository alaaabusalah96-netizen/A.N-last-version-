import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function assert(condition: boolean, label: string, details?: string) {
  if (!condition) {
    throw new Error(`[FAIL] ${label}${details ? `: ${details}` : ''}`);
  }
  console.log(`[PASS] ${label}`);
}

function resolvePlaywright(): any | null {
  const candidates = [
    'playwright',
    'playwright-core',
    '/usr/local/share/bun-global/node_modules/playwright-core',
    '/usr/local/lib/node_modules/playwright-core',
  ];
  for (const mod of candidates) {
    try {
      return require(mod);
    } catch {
      // try next
    }
  }
  return null;
}

function resolveChromiumExecutable(pw?: any): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const known = [
    '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
    '/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell',
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
  ];
  for (const p of known) {
    if (fs.existsSync(p)) return p;
  }
  if (pw && typeof pw.chromium?.executablePath === 'function') {
    try {
      const pwPath = pw.chromium.executablePath();
      if (pwPath && fs.existsSync(pwPath)) {
        return pwPath;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

async function isServerReachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

interface ShimProfile {
  role: 'company_admin' | 'platform_admin' | 'company_user';
  permissions: string[];
  username: string;
}

async function installSessionShim(page: any, getProfile: () => ShimProfile) {
  const sampleCompany = {
    id: 'comp-cash-ui-1',
    nameAr: 'شركة النور للتجارة والتوزيع',
    name: 'شركة النور للتجارة والتوزيع',
    code: 'NOUR-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    isActive: true,
  };

  const accounts = [
    {
      id: 'acc-cash-1',
      companyId: sampleCompany.id,
      code: '1101',
      name: 'الصندوق الرئيسي',
      nameAr: 'الصندوق الرئيسي',
      type: 'asset',
      accountType: 'asset',
      isPostable: true,
      isActive: true,
    },
    {
      id: 'acc-cash-2',
      companyId: sampleCompany.id,
      code: '1102',
      name: 'صندوق الفرع',
      nameAr: 'صندوق الفرع',
      type: 'asset',
      accountType: 'asset',
      isPostable: true,
      isActive: true,
    },
    {
      id: 'acc-cust-rec',
      companyId: sampleCompany.id,
      code: '1105',
      name: 'ذمة عهد الموظفين',
      nameAr: 'ذمة عهد الموظفين',
      type: 'asset',
      accountType: 'asset',
      isPostable: true,
      isActive: true,
    },
    {
      id: 'acc-liab-1',
      companyId: sampleCompany.id,
      code: '2101',
      name: 'الموردون',
      nameAr: 'الموردون',
      type: 'liability',
      accountType: 'liability',
      isPostable: true,
      isActive: true,
    },
    {
      id: 'acc-exp-1',
      companyId: sampleCompany.id,
      code: '5101',
      name: 'مصروفات ضيافة ونقل',
      nameAr: 'مصروفات ضيافة ونقل',
      type: 'expense',
      accountType: 'expense',
      isPostable: true,
      isActive: true,
    },
    {
      id: 'acc-rev-1',
      companyId: sampleCompany.id,
      code: '4101',
      name: 'إيرادات مبيعات نقدية',
      nameAr: 'إيرادات مبيعات نقدية',
      type: 'revenue',
      accountType: 'revenue',
      isPostable: true,
      isActive: true,
    },
    {
      id: 'acc-nonpost-1',
      companyId: sampleCompany.id,
      code: '1000',
      name: 'الأصول (غير مرحّل)',
      nameAr: 'الأصول (غير مرحّل)',
      type: 'asset',
      accountType: 'asset',
      isPostable: false,
      isActive: true,
    },
  ];

  const employees = [
    { userId: 'usr-emp-1', username: 'ahmed_emp', role: 'company_user', roleId: 'role-emp' },
    { userId: 'usr-emp-2', username: 'sara_acc', role: 'company_user', roleId: 'role-acc' },
  ];

  const registers: any[] = [
    {
      id: 'reg-1',
      companyId: sampleCompany.id,
      code: 'CASH-01',
      nameAr: 'الخزينة الرئيسية',
      nameEn: 'Main Cash',
      glAccountId: 'acc-cash-1',
      glAccountCode: '1101',
      glAccountNameAr: 'الصندوق الرئيسي',
      openingBalance: 10000,
      isActive: true,
      memo: 'خزينة الإدارة',
      createdAt: '2026-01-10T00:00:00.000Z',
    },
  ];

  const registerBalances: Record<string, { openingBalance: number; totalIn: number; totalOut: number; currentBalance: number }> = {
    'reg-1': { openingBalance: 10000, totalIn: 0, totalOut: 500, currentBalance: 9500 },
  };

  let custodyCounter = 5;
  const custodies: any[] = [
    {
      id: 'cus-pending-1',
      companyId: sampleCompany.id,
      custodyNo: 'CUS-0001',
      employeeUserId: 'usr-emp-1',
      employeeUsername: 'ahmed_emp',
      registerId: 'reg-1',
      registerCode: 'CASH-01',
      registerNameAr: 'الخزينة الرئيسية',
      amount: 750,
      purpose: 'مصروفات صيانة طارئة',
      status: 'pending',
      requestDate: '2026-02-01',
      requestedBy: 'usr-emp-1',
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectReason: null,
      disbursedBy: null,
      disbursedAt: null,
      settledBy: null,
      settledAt: null,
      disburseJournalEntryId: null,
      disburseJournalEntryNo: null,
      settleJournalEntryId: null,
      settleJournalEntryNo: null,
      settledExpenseTotal: null,
      settledCashReturn: null,
      memo: null,
      createdAt: '2026-02-01T10:00:00.000Z',
    },
    {
      id: 'cus-approved-2',
      companyId: sampleCompany.id,
      custodyNo: 'CUS-0002',
      employeeUserId: 'usr-emp-2',
      employeeUsername: 'sara_acc',
      registerId: 'reg-1',
      registerCode: 'CASH-01',
      registerNameAr: 'الخزينة الرئيسية',
      amount: 600,
      purpose: 'شراء مستلزمات مكتبية',
      status: 'approved',
      requestDate: '2026-02-02',
      requestedBy: 'usr-emp-2',
      approvedBy: 'usr-admin-1',
      approvedAt: '2026-02-02T11:00:00.000Z',
      rejectedBy: null,
      rejectedAt: null,
      rejectReason: null,
      disbursedBy: null,
      disbursedAt: null,
      settledBy: null,
      settledAt: null,
      disburseJournalEntryId: null,
      disburseJournalEntryNo: null,
      settleJournalEntryId: null,
      settleJournalEntryNo: null,
      settledExpenseTotal: null,
      settledCashReturn: null,
      memo: null,
      createdAt: '2026-02-02T10:00:00.000Z',
    },
    {
      id: 'cus-open-3',
      companyId: sampleCompany.id,
      custodyNo: 'CUS-0003',
      employeeUserId: 'usr-emp-1',
      employeeUsername: 'ahmed_emp',
      registerId: 'reg-1',
      registerCode: 'CASH-01',
      registerNameAr: 'الخزينة الرئيسية',
      amount: 500,
      purpose: 'مأمورية سفر ميدانية',
      status: 'open',
      requestDate: '2026-02-03',
      requestedBy: 'usr-emp-1',
      approvedBy: 'usr-admin-1',
      approvedAt: '2026-02-03T11:00:00.000Z',
      rejectedBy: null,
      rejectedAt: null,
      rejectReason: null,
      disbursedBy: 'usr-admin-1',
      disbursedAt: '2026-02-03T12:00:00.000Z',
      settledBy: null,
      settledAt: null,
      disburseJournalEntryId: 'je-disb-3',
      disburseJournalEntryNo: 'JE-2026-0041',
      settleJournalEntryId: null,
      settleJournalEntryNo: null,
      settledExpenseTotal: null,
      settledCashReturn: null,
      memo: null,
      createdAt: '2026-02-03T10:00:00.000Z',
    },
    {
      id: 'cus-settled-4',
      companyId: sampleCompany.id,
      custodyNo: 'CUS-0004',
      employeeUserId: 'usr-emp-2',
      employeeUsername: 'sara_acc',
      registerId: 'reg-1',
      registerCode: 'CASH-01',
      registerNameAr: 'الخزينة الرئيسية',
      amount: 300,
      purpose: 'ضيافة عملاء',
      status: 'settled',
      requestDate: '2026-02-04',
      requestedBy: 'usr-emp-2',
      approvedBy: 'usr-admin-1',
      approvedAt: '2026-02-04T09:00:00.000Z',
      rejectedBy: null,
      rejectedAt: null,
      rejectReason: null,
      disbursedBy: 'usr-admin-1',
      disbursedAt: '2026-02-04T10:00:00.000Z',
      settledBy: 'usr-admin-1',
      settledAt: '2026-02-05T15:00:00.000Z',
      disburseJournalEntryId: 'je-disb-4',
      disburseJournalEntryNo: 'JE-2026-0030',
      settleJournalEntryId: 'je-settle-4',
      settleJournalEntryNo: 'JE-2026-0035',
      settledExpenseTotal: 250,
      settledCashReturn: 50,
      memo: null,
      createdAt: '2026-02-04T08:00:00.000Z',
    },
  ];

  const movementsByCustodyId: Record<string, any[]> = {
    'cus-open-3': [
      {
        id: 'mov-open-1',
        custodyId: 'cus-open-3',
        registerId: 'reg-1',
        movementType: 'disburse',
        direction: 'out',
        amount: 500,
        expenseAccountId: null,
        journalEntryId: 'je-disb-3',
        journalEntryNo: 'JE-2026-0041',
        memo: 'صرف عهدة مأمورية',
        createdBy: 'usr-admin-1',
        createdAt: '2026-02-03T12:00:00.000Z',
      },
    ],
    'cus-settled-4': [
      {
        id: 'mov-set-1',
        custodyId: 'cus-settled-4',
        registerId: 'reg-1',
        movementType: 'disburse',
        direction: 'out',
        amount: 300,
        expenseAccountId: null,
        journalEntryId: 'je-disb-4',
        journalEntryNo: 'JE-2026-0030',
        memo: 'صرف عهدة ضيافة',
        createdBy: 'usr-admin-1',
        createdAt: '2026-02-04T10:00:00.000Z',
      },
      {
        id: 'mov-set-2',
        custodyId: 'cus-settled-4',
        registerId: 'reg-1',
        movementType: 'settle_expense',
        direction: 'none',
        amount: 250,
        expenseAccountId: 'acc-exp-1',
        expenseAccountCode: '5101',
        expenseAccountNameAr: 'مصروفات ضيافة ونقل',
        journalEntryId: 'je-settle-4',
        journalEntryNo: 'JE-2026-0035',
        memo: 'فواتير ضيافة',
        createdBy: 'usr-admin-1',
        createdAt: '2026-02-05T15:00:00.000Z',
      },
      {
        id: 'mov-set-3',
        custodyId: 'cus-settled-4',
        registerId: 'reg-1',
        movementType: 'settle_return',
        direction: 'in',
        amount: 50,
        expenseAccountId: null,
        journalEntryId: 'je-settle-4',
        journalEntryNo: 'JE-2026-0035',
        memo: 'مرتجع نقدي للصندوق',
        createdBy: 'usr-admin-1',
        createdAt: '2026-02-05T15:00:00.000Z',
      },
    ],
  };

  const receiptVouchers: any[] = [
    {
      id: 'rcv-draft-1',
      companyId: sampleCompany.id,
      kind: 'receipt',
      voucherNo: null,
      registerId: 'reg-1',
      registerCode: 'CASH-01',
      registerNameAr: 'الخزينة الرئيسية',
      voucherDate: '2026-02-11',
      amount: 1200,
      contraAccountId: 'acc-rev-1',
      contraAccountCode: '4101',
      contraAccountNameAr: 'إيرادات مبيعات نقدية',
      status: 'draft',
      memo: 'مسودة سند قبض نقدي',
      reference: 'CRV-REF-1',
      journalEntryId: null,
      journalEntryNo: null,
      createdAt: '2026-02-11T09:00:00.000Z',
    },
    {
      id: 'rcv-posted-1',
      companyId: sampleCompany.id,
      kind: 'receipt',
      voucherNo: 'CRV-0001',
      registerId: 'reg-1',
      registerCode: 'CASH-01',
      registerNameAr: 'الخزينة الرئيسية',
      voucherDate: '2026-02-10',
      amount: 850,
      contraAccountId: 'acc-rev-1',
      contraAccountCode: '4101',
      contraAccountNameAr: 'إيرادات مبيعات نقدية',
      status: 'posted',
      memo: 'تحصيل مبيعات نقدية',
      reference: 'INV-881',
      journalEntryId: 'je-rcv-1',
      journalEntryNo: 'JE-2026-0044',
      createdAt: '2026-02-10T10:00:00.000Z',
    },
  ];

  const paymentVouchers: any[] = [
    {
      id: 'pay-over-1',
      companyId: sampleCompany.id,
      kind: 'payment',
      voucherNo: null,
      registerId: 'reg-1',
      registerCode: 'CASH-01',
      registerNameAr: 'الخزينة الرئيسية',
      voucherDate: '2026-02-12',
      amount: 99000,
      contraAccountId: 'acc-exp-1',
      contraAccountCode: '5101',
      contraAccountNameAr: 'مصروفات ضيافة ونقل',
      status: 'draft',
      memo: 'سند صرف يتجاوز رصيد الصندوق',
      reference: 'PAY-ERR-1',
      journalEntryId: null,
      journalEntryNo: null,
      createdAt: '2026-02-12T08:00:00.000Z',
    },
    {
      id: 'pay-posted-1',
      companyId: sampleCompany.id,
      kind: 'payment',
      voucherNo: 'CPV-0001',
      registerId: 'reg-1',
      registerCode: 'CASH-01',
      registerNameAr: 'الخزينة الرئيسية',
      voucherDate: '2026-02-09',
      amount: 350,
      contraAccountId: 'acc-exp-1',
      contraAccountCode: '5101',
      contraAccountNameAr: 'مصروفات ضيافة ونقل',
      status: 'posted',
      memo: 'سداد فاتورة ضيافة',
      reference: 'BILL-19',
      journalEntryId: 'je-pay-1',
      journalEntryNo: 'JE-2026-0042',
      createdAt: '2026-02-09T14:00:00.000Z',
    },
  ];

  let voucherSeq = 2;
  let jeSeq = 50;

  await page.route('**/api/**', async (route: any) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;
    const method = req.method().toUpperCase();
    const profile = getProfile();

    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    const hasPerm = (perm: string) => profile.role === 'platform_admin' || profile.permissions.includes(perm);

    const parseBody = () => {
      try {
        return JSON.parse(req.postData() || '{}');
      } catch {
        return {};
      }
    };

    if (pathname === '/api/auth/csrf') {
      return json({ status: 'ok', csrfToken: 'verify-csrf-token' });
    }
    if (pathname === '/api/auth/me') {
      return json({
        status: 'ok',
        user: { id: 'usr-verify-1', username: profile.username, role: profile.role },
        permissions: profile.permissions,
        memberships: [{ companyId: sampleCompany.id, role: profile.role }],
      });
    }
    if (pathname === '/api/companies') {
      return json({ status: 'ok', companies: [sampleCompany] });
    }
    if (pathname.endsWith('/org-units')) {
      return json({
        status: 'ok',
        orgUnits: [{ id: 'org-1', companyId: sampleCompany.id, code: 'HQ', nameAr: 'المركز الرئيسي', name: 'المركز الرئيسي', type: 'branch', parentId: null, isActive: true }],
      });
    }
    if (pathname.endsWith('/settings')) {
      return json({
        status: 'ok',
        settings: {
          companyId: sampleCompany.id,
          defaultCurrencyCode: 'SAR',
          fiscalYearStartMonth: 1,
          fiscalYearStartDay: 1,
          timezone: 'Asia/Riyadh',
          locale: 'ar-SA',
          displayNameFinance: 'الإدارة المالية',
          inventoryAccountId: 'acc-cash-1',
          purchasesClearingAccountId: 'acc-liab-1',
          custodyReceivableAccountId: 'acc-cust-rec',
        },
      });
    }
    if (pathname.endsWith('/custom-fields')) {
      return json({ status: 'ok', fields: [] });
    }
    if (pathname === '/api/accounting/accounts') {
      return json({ status: 'ok', accounts });
    }
    if (pathname === '/api/accounting/journals') {
      return json({ status: 'ok', journals: [] });
    }
    if (pathname === '/api/accounting/periods') {
      return json({ status: 'ok', periods: [] });
    }
    if (pathname === '/api/accounting/gl-events') {
      return json({ status: 'ok', events: [] });
    }
    if (pathname.startsWith('/api/inventory/') || pathname.startsWith('/api/purchasing/')) {
      return json({ status: 'ok', warehouses: [], items: [], balances: [], movements: [], suppliers: [], receipts: [], grns: [] });
    }

    // Cash registers
    if (pathname === '/api/cash/registers' && method === 'GET') {
      return json({ status: 'ok', registers });
    }
    if (pathname === '/api/cash/registers' && method === 'POST') {
      if (!hasPerm('cash:write')) {
        return json({ status: 'error', message: 'ليس لديك صلاحية إنشاء أو تعديل الصناديق (cash:write)' }, 403);
      }
      const b = parseBody();
      const acc = accounts.find((a) => a.id === b.glAccountId);
      const id = `reg-${registers.length + 1}`;
      const opening = Number(b.openingBalance || 0);
      const created = {
        id,
        companyId: sampleCompany.id,
        code: b.code,
        nameAr: b.nameAr,
        nameEn: b.nameEn || null,
        glAccountId: b.glAccountId,
        glAccountCode: acc?.code || '1102',
        glAccountNameAr: acc?.nameAr || 'صندوق',
        openingBalance: opening,
        isActive: true,
        memo: b.memo || null,
        createdAt: new Date().toISOString(),
      };
      registers.push(created);
      registerBalances[id] = { openingBalance: opening, totalIn: 0, totalOut: 0, currentBalance: opening };
      return json({ status: 'ok', register: created }, 201);
    }

    const regBalMatch = pathname.match(/^\/api\/cash\/registers\/([^/]+)\/balance$/);
    if (regBalMatch && method === 'GET') {
      const regId = regBalMatch[1];
      const bal = registerBalances[regId] || { openingBalance: 0, totalIn: 0, totalOut: 0, currentBalance: 0 };
      return json({ status: 'ok', balance: { registerId: regId, ...bal } });
    }

    // Employees
    if (pathname === '/api/cash/custodies/employees' && method === 'GET') {
      return json({ status: 'ok', employees });
    }

    // Custodies list & create
    if (pathname === '/api/cash/custodies' && method === 'GET') {
      const st = url.searchParams.get('status') || '';
      const empId = url.searchParams.get('employeeUserId') || '';
      const regId = url.searchParams.get('registerId') || '';
      const filtered = custodies.filter((c) => {
        if (st && c.status !== st) return false;
        if (empId && c.employeeUserId !== empId) return false;
        if (regId && c.registerId !== regId) return false;
        return true;
      });
      return json({ status: 'ok', custodies: filtered });
    }
    if (pathname === '/api/cash/custodies' && method === 'POST') {
      if (!hasPerm('custody:request')) {
        return json({ status: 'error', message: 'ليس لديك صلاحية تقديم طلب عهدة (custody:request)' }, 403);
      }
      const b = parseBody();
      const emp = employees.find((e) => e.userId === b.employeeUserId);
      const reg = registers.find((r) => r.id === b.registerId);
      const no = `CUS-${String(custodyCounter++).padStart(4, '0')}`;
      const newCustody = {
        id: `cus-new-${custodyCounter}`,
        companyId: sampleCompany.id,
        custodyNo: no,
        employeeUserId: b.employeeUserId,
        employeeUsername: emp?.username || 'employee',
        registerId: b.registerId,
        registerCode: reg?.code || 'CASH-01',
        registerNameAr: reg?.nameAr || 'الخزينة الرئيسية',
        amount: Number(b.amount || 0),
        purpose: b.purpose,
        status: 'pending',
        requestDate: b.requestDate || '2026-02-10',
        requestedBy: 'usr-verify-1',
        approvedBy: null,
        approvedAt: null,
        rejectedBy: null,
        rejectedAt: null,
        rejectReason: null,
        disbursedBy: null,
        disbursedAt: null,
        settledBy: null,
        settledAt: null,
        disburseJournalEntryId: null,
        disburseJournalEntryNo: null,
        settleJournalEntryId: null,
        settleJournalEntryNo: null,
        settledExpenseTotal: null,
        settledCashReturn: null,
        memo: b.memo || null,
        createdAt: new Date().toISOString(),
      };
      custodies.unshift(newCustody);
      movementsByCustodyId[newCustody.id] = [];
      return json({ status: 'ok', custody: newCustody }, 201);
    }

    // Custody detail / movements / lifecycle actions
    const cusMovMatch = pathname.match(/^\/api\/cash\/custodies\/([^/]+)\/movements$/);
    if (cusMovMatch && method === 'GET') {
      return json({ status: 'ok', movements: movementsByCustodyId[cusMovMatch[1]] || [] });
    }

    const cusActMatch = pathname.match(/^\/api\/cash\/custodies\/([^/]+)\/(approve|reject|disburse|settle|cancel)$/);
    if (cusActMatch && method === 'POST') {
      const [, id, act] = cusActMatch;
      const target = custodies.find((c) => c.id === id);
      if (!target) return json({ status: 'error', message: 'العهدة غير موجودة' }, 404);
      const b = parseBody();

      if (act === 'approve') {
        if (!hasPerm('custody:approve')) {
          return json({ status: 'error', message: 'صلاحية غير كافية: لا تملك صلاحية اعتماد العهد (custody:approve)' }, 403);
        }
        target.status = 'approved';
        return json({ status: 'ok', custody: target });
      }
      if (act === 'reject') {
        if (!hasPerm('custody:approve')) {
          return json({ status: 'error', message: 'صلاحية غير كافية: لا تملك صلاحية رفض العهد (custody:approve)' }, 403);
        }
        if (!b.reason || String(b.reason).trim().length < 5) {
          return json({ status: 'error', message: 'سبب الرفض مطلوب ويجب ألا يقل عن 5 أحرف' }, 400);
        }
        target.status = 'rejected';
        target.rejectReason = b.reason;
        return json({ status: 'ok', custody: target });
      }
      if (act === 'disburse') {
        if (!hasPerm('custody:disburse')) {
          return json({ status: 'error', message: 'صلاحية غير كافية: لا تملك صلاحية صرف العهد (custody:disburse)' }, 403);
        }
        target.status = 'open';
        const jeNo = `JE-2026-00${jeSeq++}`;
        target.disburseJournalEntryNo = jeNo;
        const mov = {
          id: `mov-disb-${jeSeq}`,
          custodyId: target.id,
          registerId: target.registerId,
          movementType: 'disburse',
          direction: 'out',
          amount: target.amount,
          expenseAccountId: null,
          journalEntryNo: jeNo,
          memo: 'صرف العهدة',
          createdAt: new Date().toISOString(),
        };
        movementsByCustodyId[target.id] = [...(movementsByCustodyId[target.id] || []), mov];
        if (registerBalances[target.registerId]) {
          registerBalances[target.registerId].totalOut += Number(target.amount);
          registerBalances[target.registerId].currentBalance -= Number(target.amount);
        }
        return json({ status: 'ok', custody: target });
      }
      if (act === 'settle') {
        if (!hasPerm('custody:settle')) {
          return json({ status: 'error', message: 'صلاحية غير كافية: لا تملك صلاحية تسوية العهد (custody:settle)' }, 403);
        }
        const lines: any[] = Array.isArray(b.lines) ? b.lines : [];
        let expSum = 0;
        for (const l of lines) {
          if (!l.expenseAccountId) {
            return json({ status: 'error', message: 'يجب تحديد حساب المصروف لكل سطر تسوية' }, 400);
          }
          expSum += Number(l.amount || 0);
        }
        const cashReturn = Number(b.cashReturn || 0);
        if (Math.round((expSum + cashReturn) * 100) !== Math.round(Number(target.amount) * 100)) {
          return json({ status: 'error', message: 'مجموع المصروفات والمرتجع النقدي لا يطابق مبلغ العهدة' }, 400);
        }
        target.status = 'settled';
        const jeNo = `JE-2026-00${jeSeq++}`;
        target.settleJournalEntryNo = jeNo;
        target.settledExpenseTotal = expSum;
        target.settledCashReturn = cashReturn;
        for (const l of lines) {
          const acc = accounts.find((a) => a.id === l.expenseAccountId);
          movementsByCustodyId[target.id].push({
            id: `mov-exp-${jeSeq++}`,
            custodyId: target.id,
            registerId: target.registerId,
            movementType: 'settle_expense',
            direction: 'none',
            amount: Number(l.amount),
            expenseAccountId: l.expenseAccountId,
            expenseAccountCode: acc?.code || '5101',
            expenseAccountNameAr: acc?.nameAr || 'مصروف',
            journalEntryNo: jeNo,
            memo: l.memo || null,
            createdAt: new Date().toISOString(),
          });
        }
        if (cashReturn > 0) {
          movementsByCustodyId[target.id].push({
            id: `mov-ret-${jeSeq++}`,
            custodyId: target.id,
            registerId: target.registerId,
            movementType: 'settle_return',
            direction: 'in',
            amount: cashReturn,
            expenseAccountId: null,
            journalEntryNo: jeNo,
            memo: 'مرتجع نقدي',
            createdAt: new Date().toISOString(),
          });
        }
        return json({ status: 'ok', custody: target });
      }
      if (act === 'cancel') {
        target.status = 'cancelled';
        return json({ status: 'ok', custody: target });
      }
    }

    const cusGetMatch = pathname.match(/^\/api\/cash\/custodies\/([^/]+)$/);
    if (cusGetMatch && method === 'GET') {
      const target = custodies.find((c) => c.id === cusGetMatch[1]);
      return target ? json({ status: 'ok', custody: target }) : json({ status: 'error', message: 'غير موجود' }, 404);
    }

    if (pathname === '/api/cash/reports/open-custodies' && method === 'GET') {
      const map = new Map<string, { employeeUserId: string; employeeUsername: string; openCount: number; totalAmount: number }>();
      for (const c of custodies) {
        if (c.status === 'open') {
          const cur = map.get(c.employeeUserId) || {
            employeeUserId: c.employeeUserId,
            employeeUsername: c.employeeUsername,
            openCount: 0,
            totalAmount: 0,
          };
          cur.openCount += 1;
          cur.totalAmount += Number(c.amount);
          map.set(c.employeeUserId, cur);
        }
      }
      return json({ status: 'ok', summary: Array.from(map.values()) });
    }

    if (pathname === '/api/cash/reports/register-movements' && method === 'GET') {
      const regId = url.searchParams.get('registerId') || 'reg-1';
      const reg = registers.find((r) => r.id === regId) || registers[0];
      const bal = registerBalances[reg.id] || { openingBalance: 10000, totalIn: 850, totalOut: 850, currentBalance: 10000 };
      const rows = [
        {
          id: 'rep-mov-1',
          sourceType: 'receipt_voucher',
          movementLabelAr: 'سند قبض',
          movementDate: '2026-02-10',
          inAmount: 850,
          outAmount: 0,
          reference: 'INV-881',
          actorUsername: 'company_admin_verify',
          journalEntryId: 'je-rcv-1',
          journalEntryNo: 'JE-2026-0044',
          memo: 'تحصيل مبيعات نقدية',
        },
        {
          id: 'rep-mov-2',
          sourceType: 'payment_voucher',
          movementLabelAr: 'سند صرف',
          movementDate: '2026-02-09',
          inAmount: 0,
          outAmount: 350,
          reference: 'BILL-19',
          actorUsername: 'company_admin_verify',
          journalEntryId: 'je-pay-1',
          journalEntryNo: 'JE-2026-0042',
          memo: 'سداد فاتورة ضيافة',
        },
        {
          id: 'rep-mov-3',
          sourceType: 'custody_disburse',
          movementLabelAr: 'صرف عهدة',
          movementDate: '2026-02-03',
          inAmount: 0,
          outAmount: 500,
          reference: 'CUS-0003',
          actorUsername: 'usr-admin-1',
          journalEntryId: 'je-disb-3',
          journalEntryNo: 'JE-2026-0041',
          memo: 'صرف عهدة مأمورية',
        },
      ];
      return json({
        status: 'ok',
        report: {
          registerId: reg.id,
          registerCode: reg.code,
          registerNameAr: reg.nameAr,
          openingBalance: bal.openingBalance,
          totalIn: 850,
          totalOut: 850,
          closingBalance: bal.currentBalance,
          rows,
        },
      });
    }

    if (pathname === '/api/cash/reports/custody-by-employee' && method === 'GET') {
      const empId = url.searchParams.get('employeeUserId') || 'usr-emp-1';
      const empMovs: any[] = [];
      for (const c of custodies) {
        if (c.employeeUserId !== empId) continue;
        for (const m of movementsByCustodyId[c.id] || []) {
          empMovs.push({
            id: m.id,
            custodyId: c.id,
            custodyNo: c.custodyNo,
            custodyStatus: c.status,
            registerCode: c.registerCode || 'CASH-01',
            registerNameAr: c.registerNameAr || 'الخزينة الرئيسية',
            movementType: m.movementType,
            movementLabelAr:
              m.movementType === 'disburse'
                ? 'صرف عهدة'
                : m.movementType === 'settle_expense'
                ? 'تسوية مصروف عهدة'
                : 'مرتجع نقدي من عهدة',
            direction: m.direction,
            amount: m.amount,
            expenseAccountCode: m.expenseAccountCode || null,
            expenseAccountNameAr: m.expenseAccountNameAr || null,
            journalEntryNo: m.journalEntryNo || 'JE-2026-0041',
            memo: m.memo || null,
            createdAt: m.createdAt,
          });
        }
      }
      return json({ status: 'ok', movements: empMovs });
    }

    // Receipt & Payment Vouchers
    if ((pathname === '/api/cash/receipt-vouchers' || pathname === '/api/cash/payment-vouchers') && method === 'GET') {
      const isReceipt = pathname.includes('receipt-vouchers');
      return json({ status: 'ok', vouchers: isReceipt ? receiptVouchers : paymentVouchers });
    }

    if ((pathname === '/api/cash/receipt-vouchers' || pathname === '/api/cash/payment-vouchers') && method === 'POST') {
      if (!hasPerm('cash:write')) {
        return json({ status: 'error', message: 'صلاحية غير كافية: يتطلب (cash:write)' }, 403);
      }
      const isReceipt = pathname.includes('receipt-vouchers');
      const b = parseBody();
      const reg = registers.find((r) => r.id === b.registerId);
      const acc = accounts.find((a) => a.id === b.contraAccountId);
      const list = isReceipt ? receiptVouchers : paymentVouchers;
      const created = {
        id: `${isReceipt ? 'rcv' : 'pay'}-new-${voucherSeq++}`,
        companyId: sampleCompany.id,
        kind: isReceipt ? 'receipt' : 'payment',
        voucherNo: null,
        registerId: b.registerId,
        registerCode: reg?.code || 'CASH-01',
        registerNameAr: reg?.nameAr || 'الخزينة الرئيسية',
        voucherDate: b.voucherDate || '2026-02-12',
        amount: Number(b.amount || 0),
        contraAccountId: b.contraAccountId,
        contraAccountCode: acc?.code || '4101',
        contraAccountNameAr: acc?.nameAr || 'حساب طرف',
        status: 'draft',
        memo: b.memo || null,
        reference: b.reference || null,
        journalEntryId: null,
        journalEntryNo: null,
        createdAt: new Date().toISOString(),
      };
      list.unshift(created);
      return json({ status: 'ok', voucher: created }, 201);
    }

    const vchActMatch = pathname.match(/^\/api\/cash\/(receipt|payment)-vouchers\/([^/]+)\/(post|cancel)$/);
    if (vchActMatch && method === 'POST') {
      if (!hasPerm('cash:write')) {
        return json({ status: 'error', message: 'صلاحية غير كافية: يتطلب (cash:write)' }, 403);
      }
      const [, kindSlug, id, act] = vchActMatch;
      const isReceipt = kindSlug === 'receipt';
      const list = isReceipt ? receiptVouchers : paymentVouchers;
      const target = list.find((v) => v.id === id);
      if (!target) return json({ status: 'error', message: 'السند غير موجود' }, 404);
      if (act === 'cancel') {
        if (target.status === 'posted') {
          return json(
            {
              status: 'error',
              message: 'لا يمكن إلغاء سند مرحّل لوجود قيد محاسبي مرتبط به — يرجى استخدام العكس المحاسبي المعتمد (JournalService.reverseEntry)',
            },
            400
          );
        }
        target.status = 'cancelled';
        return json({ status: 'ok', voucher: target });
      }
      // post action
      if (!isReceipt) {
        const bal = registerBalances[target.registerId]?.currentBalance ?? 0;
        if (bal < Number(target.amount)) {
          return json(
            {
              status: 'error',
              message: `رصيد الصندوق (${target.registerNameAr}) غير كافٍ للصرف: الرصيد المتاح ${bal.toFixed(2)}، والمطلوب ${Number(target.amount).toFixed(2)}`,
            },
            400
          );
        }
      }
      target.status = 'posted';
      target.voucherNo = target.voucherNo || `${isReceipt ? 'CRV' : 'CPV'}-${String(voucherSeq++).padStart(4, '0')}`;
      target.journalEntryId = `je-vch-${jeSeq}`;
      target.journalEntryNo = `JE-2026-00${jeSeq++}`;
      if (registerBalances[target.registerId]) {
        if (isReceipt) {
          registerBalances[target.registerId].totalIn += Number(target.amount);
          registerBalances[target.registerId].currentBalance += Number(target.amount);
        } else {
          registerBalances[target.registerId].totalOut += Number(target.amount);
          registerBalances[target.registerId].currentBalance -= Number(target.amount);
        }
      }
      return json({ status: 'ok', voucher: target });
    }

    // Config Platform definitions & structured form endpoints (U18)
    if (pathname === '/api/config/definitions') {
      return json({
        status: 'ok',
        definitions: [
          {
            id: 'def-grn',
            key: 'accounting.grn_mapping',
            domain: 'accounting',
            labelAr: 'ربط استلام البضائع بالدليل',
            description: 'حساب المخزون ومقاصة المشتريات',
            defaultValue: { inventory_account_id: '', purchases_clearing_account_id: '' },
          },
          {
            id: 'def-custody',
            key: 'accounting.custody_mapping',
            domain: 'accounting',
            labelAr: 'ربط عهد الموظفين بالدليل',
            description: 'حساب ذمة عهد الموظفين الافتراضي',
            defaultValue: { custody_receivable_account_id: '' },
          },
        ],
      });
    }
    if (pathname.endsWith('/config/draft')) {
      const k = url.searchParams.get('key') || 'accounting.grn_mapping';
      return json({
        status: 'ok',
        draft: {
          id: 'draft-1',
          status: 'draft',
          content: k === 'accounting.custody_mapping' ? { custody_receivable_account_id: 'acc-cust-rec' } : {},
        },
      });
    }
    if (pathname.endsWith('/config/versions')) {
      return json({ status: 'ok', versions: [] });
    }
    if (pathname.endsWith('/config/resolve')) {
      const k = url.searchParams.get('key') || 'accounting.grn_mapping';
      return json({
        status: 'ok',
        resolved: {
          key: k,
          definitionId: k === 'accounting.custody_mapping' ? 'def-custody' : 'def-grn',
          source: 'platform_default',
          versionNo: null,
          content: k === 'accounting.custody_mapping' ? { custody_receivable_account_id: 'acc-cust-rec' } : {},
        },
      });
    }

    if (pathname === '/api/users') {
      return json({
        status: 'ok',
        users: [{ id: 'usr-verify-1', username: profile.username, role: profile.role, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' }],
      });
    }
    if (pathname === '/api/roles') {
      return json({ status: 'ok', roles: [] });
    }
    return json({ status: 'ok' });
  });
}

async function runStaticChecks(): Promise<number> {
  console.log('=== WP-7 (أ) Static Verification U1..U7 ===');
  let staticPassed = 0;

  // U1
  const workspacePath = path.resolve(process.cwd(), 'src/components/cash/CashCustodyWorkspace.tsx');
  assert(fs.existsSync(workspacePath), 'U1: CashCustodyWorkspace.tsx exists');
  const workspaceContent = fs.readFileSync(workspacePath, 'utf8');
  assert(workspaceContent.includes('apiFetch'), 'U1: CashCustodyWorkspace imports/uses apiFetch');
  staticPassed++;

  // U2
  const sidebarPath = path.resolve(process.cwd(), 'src/components/shell/AppSidebar.tsx');
  const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');
  assert(
    sidebarContent.includes("onNavigate('cash')") && sidebarContent.includes('الخزينة والعهد'),
    "U2: AppSidebar contains onNavigate('cash') and label 'الخزينة والعهد'"
  );
  staticPassed++;

  // U3
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');
  assert(
    appContent.includes("'cash'") &&
      appContent.includes('CashCustodyWorkspace') &&
      appContent.includes('permissions={currentUser.permissions'),
    "U3: App.tsx includes 'cash' nav route, CashCustodyWorkspace switcher, and permissions prop passing"
  );
  staticPassed++;

  // U4
  assert(
    !/firebase|firestore|offlineQueue|localStorage/i.test(workspaceContent),
    'U4: No firebase/firestore/offlineQueue/localStorage in CashCustodyWorkspace.tsx'
  );
  staticPassed++;

  // U5
  assert(
    !workspaceContent.includes('.reduce(') && !/\bopening(Balance)?\s*\+/.test(workspaceContent),
    'U5: No reduce() or opening + balance calculation on client in CashCustodyWorkspace.tsx'
  );
  staticPassed++;

  // U6
  const mig038Path = path.resolve(process.cwd(), 'database/migrations/038_cash_custody_core.sql');
  const mig038 = fs.readFileSync(mig038Path, 'utf8');
  const checkMatch = mig038.match(/CHECK\s*\(status\s+IN\s*\(([^)]+)\)\)/);
  assert(Boolean(checkMatch), 'U6: Migration 038 status CHECK constraint parsed');
  const migrationStatuses = checkMatch![1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .sort();
  const uiStatusesMatch = workspaceContent.match(/type CustodyStatus\s*=\s*([^;]+);/);
  assert(Boolean(uiStatusesMatch), 'U6: UI CustodyStatus type parsed');
  const uiStatuses = uiStatusesMatch![1]
    .split('|')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
    .sort();
  assert(
    JSON.stringify(migrationStatuses) === JSON.stringify(uiStatuses),
    `U6: 6 statuses match CHECK constraint (${migrationStatuses.join(',')})`
  );
  staticPassed++;

  // U7
  const sidebarScriptPath = path.resolve(process.cwd(), 'scripts/verifySidebarLayout1.ts');
  const sidebarScriptContent = fs.readFileSync(sidebarScriptPath, 'utf8');
  assert(
    sidebarScriptContent.includes("key: 'cash'") && sidebarScriptContent.includes('الخزينة والعهد'),
    "U7: ALL_TABS in scripts/verifySidebarLayout1.ts contains 'cash'"
  );
  staticPassed++;

  console.log(`Static checks U1..U7: ${staticPassed}/7 PASS`);
  return staticPassed;
}

async function openCashNav(page: any, viewportWidth: number) {
  if (viewportWidth < 1024) {
    const hamburger = page.locator('button[aria-label="فتح القائمة"]');
    if ((await hamburger.count()) > 0 && (await hamburger.isVisible())) {
      await hamburger.click();
      await page.waitForTimeout(200);
    }
  }
  const navBtn = page.locator('aside button:has-text("الخزينة والعهد")').first();
  await navBtn.waitFor({ state: 'attached', timeout: 10000 });
  return navBtn;
}

async function main() {
  const staticCount = await runStaticChecks();

  const appUrl = process.env.VERIFY_APP_URL || 'http://127.0.0.1:3000';
  const useSessionShim = process.env.VERIFY_SESSION_SHIM === '1';

  const pw = resolvePlaywright();
  if (!pw) {
    console.log('[BLOCKED] Playwright/playwright-core is not installed in this environment (cannot run U8..U21 browser checks).');
    process.exit(2);
  }

  const executablePath = resolveChromiumExecutable(pw);
  if (!executablePath) {
    console.log('[BLOCKED] Chromium headless binary not found in this environment (cannot run U8..U21 browser checks).');
    process.exit(2);
  }

  if (!(await isServerReachable(appUrl))) {
    console.log(`[BLOCKED] App server is not reachable at ${appUrl}. Start app before running UI browser verification.`);
    process.exit(2);
  }

  if (!useSessionShim) {
    console.log('[BLOCKED] VERIFY_SESSION_SHIM=1 is required for deterministic UI browser verification.');
    process.exit(2);
  }

  console.log('\n=== WP-7 (ب) Browser Verification U8..U21 ===');
  const chromium = pw.chromium;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let expectingIntentionalHttpError = false;
  let browserPassed = 0;

  let currentProfile: ShimProfile = {
    role: 'company_admin',
    username: 'company_admin_verify',
    permissions: ['cash:read', 'cash:write', 'custody:request', 'custody:approve', 'custody:disburse', 'custody:settle'],
  };

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar' });
    const page = await context.newPage();

    page.on('console', (msg: any) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (
          !text.includes('WebSocket') &&
          !text.includes('hmr') &&
          !(expectingIntentionalHttpError && text.includes('Failed to load resource'))
        ) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', (err: Error) => {
      pageErrors.push(err.message);
    });

    await installSessionShim(page, () => currentProfile);
    await page.goto(appUrl, { waitUntil: 'networkidle' });
    await page.locator('aside').waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(300);

    // U8: Sidebar item visible across 1280, 768, 390
    for (const vp of [
      { width: 1280, height: 800 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(200);
      const navBtn = await openCashNav(page, vp.width);
      const rect = await navBtn.evaluate((el: Element) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height, left: r.left, right: r.right };
      });
      assert(
        rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < vp.width,
        `U8 (${vp.width}px): nav item visible inside <aside>`,
        JSON.stringify(rect)
      );
      if (vp.width < 1024) {
        await navBtn.click();
        await page.waitForTimeout(200);
      }
    }
    browserPassed++; // U8
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(200);

    // U9: Click nav -> <main h2> text is الخزينة والعهد
    const cashNavDesktop = page.locator('aside button:has-text("الخزينة والعهد")').first();
    await cashNavDesktop.click();
    await page.waitForTimeout(400);
    const h2Text = (await page.locator('main h2').textContent())?.trim() || '';
    assert(h2Text === 'الخزينة والعهد', `U9: <main h2> === "الخزينة والعهد" (got "${h2Text}")`);
    browserPassed++; // U9

    // U10: 3 tabs visible by exact text
    for (const tabLabel of ['الصناديق', 'العهد', 'أرصدة العهد المفتوحة']) {
      const tabBtn = page.locator(`[role="tab"]:has-text("${tabLabel}")`).first();
      await tabBtn.waitFor({ state: 'visible', timeout: 5000 });
      assert(await tabBtn.isVisible(), `U10: Tab "${tabLabel}" visible`);
    }
    browserPassed++; // U10

    // U11: Clicking each tab renders real content (table + non-empty API balance cell / filter bar / table)
    await page.locator('[role="tab"]', { hasText: /^الصناديق$/ }).click();
    await page.waitForTimeout(300);
    const regBalCellText = (await page.locator('table tbody tr td').nth(3).textContent())?.trim() || '';
    assert(regBalCellText === '9500.00', `U11/item8: Register balance column from API === "9500.00" (got "${regBalCellText}")`);

    await page.locator('[role="tab"]', { hasText: /^العهد$/ }).click();
    await page.waitForTimeout(300);
    assert(await page.locator('[data-testid="custody-filter-bar"]').isVisible(), 'U11: Custody filter bar visible');

    await page.locator('[role="tab"]', { hasText: /^أرصدة العهد المفتوحة$/ }).click();
    await page.waitForTimeout(200);
    assert(await page.locator('table thead th:has-text("عدد العهد")').isVisible(), 'U11: Open balances tab table visible');
    browserPassed++; // U11

    // U12: Click صندوق جديد -> modal inputs & glAccountId filtered options from shim
    await page.locator('[role="tab"]', { hasText: /^الصناديق$/ }).click();
    await page.locator('button:has-text("صندوق جديد")').click();
    await page.waitForTimeout(200);
    assert(await page.locator('input[name="code"]').isVisible(), 'U12: input[name="code"] visible');
    assert(await page.locator('input[name="nameAr"]').isVisible(), 'U12: input[name="nameAr"] visible');
    assert(await page.locator('input[name="openingBalance"]').isVisible(), 'U12: input[name="openingBalance"] visible');
    assert(await page.locator('input[name="memo"]').isVisible(), 'U12: input[name="memo"] visible');
    const glOptsText = await page.locator('select[name="glAccountId"] option').allTextContents();
    assert(
      glOptsText.some((t: string) => t.includes('1101')) &&
        !glOptsText.some((t: string) => t.includes('2101')) &&
        !glOptsText.some((t: string) => t.includes('5101')) &&
        !glOptsText.some((t: string) => t.includes('1000')),
      `U12: glAccountId select filtered strictly to postable asset accounts (${glOptsText.join(' | ')})`
    );
    // M2 verification inline: create a second cash register & verify it appears with opening balance
    await page.locator('input[name="code"]').fill('CASH-02');
    await page.locator('input[name="nameAr"]').fill('صندوق فرعي');
    await page.locator('select[name="glAccountId"]').selectOption('acc-cash-2');
    await page.locator('input[name="openingBalance"]').fill('2500');
    await page.locator('button:has-text("حفظ الصندوق")').click();
    await page.waitForTimeout(400);
    assert(await page.locator('table tbody tr:has-text("CASH-02")').isVisible(), 'M2: Created register CASH-02 visible');
    assert(
      (await page.locator('table tbody tr:has-text("CASH-02") td').nth(3).textContent())?.trim() === '2500.00',
      'M2: Created register displays server balance 2500.00'
    );
    browserPassed++; // U12

    // U13: Click طلب عهدة -> modal shows employeeUserId populated from /custodies/employees + registerId + amount + purpose
    await page.locator('button:has-text("طلب عهدة")').click();
    await page.waitForTimeout(200);
    const empOpts = await page.locator('select[name="employeeUserId"] option').allTextContents();
    assert(empOpts.some((t: string) => t.includes('ahmed_emp')), `U13: employeeUserId populated from /custodies/employees (${empOpts.join(',')})`);
    assert(await page.locator('select[name="registerId"]').isVisible(), 'U13: registerId visible');
    assert(await page.locator('input[name="amount"]').isVisible(), 'U13: amount visible');
    assert(await page.locator('textarea[name="purpose"]').isVisible(), 'U13: purpose visible');
    // M3: submit request custody and check pending row with employee name & custodyNo
    await page.locator('select[name="employeeUserId"]').selectOption('usr-emp-1');
    await page.locator('select[name="registerId"]').selectOption('reg-1');
    await page.locator('input[name="amount"]').fill('400');
    await page.locator('textarea[name="purpose"]').fill('مهمة شراء عاجلة');
    await page.locator('button:has-text("إرسال الطلب")').click();
    await page.waitForTimeout(400);
    assert(await page.locator('table tbody tr:has-text("CUS-0005")').isVisible(), 'M3: New custody CUS-0005 appears as pending');
    browserPassed++; // U13

    // U14: Row action buttons strictly match status
    const pendingRow = page.locator('tr[data-custody-status="pending"]').first();
    assert(await pendingRow.locator('button:has-text("اعتماد")').isVisible(), 'U14: pending row has اعتماد');
    assert(await pendingRow.locator('button:has-text("رفض")').isVisible(), 'U14: pending row has رفض');
    assert(await pendingRow.locator('button:has-text("إلغاء")').isVisible(), 'U14: pending row has إلغاء');

    const approvedRow = page.locator('tr[data-custody-status="approved"]').first();
    assert(await approvedRow.locator('button:has-text("صرف")').isVisible(), 'U14: approved row has صرف');
    assert((await approvedRow.locator('button:has-text("اعتماد")').count()) === 0, 'U14: approved row does NOT have اعتماد');

    const openRow = page.locator('tr[data-custody-status="open"]').first();
    assert(await openRow.locator('button:has-text("تسوية")').isVisible(), 'U14: open row has تسوية');

    const settledRow = page.locator('tr[data-custody-status="settled"]').first();
    const settledActionBtns = await settledRow.locator('td').last().locator('button').count();
    assert(settledActionBtns === 0, `U14: settled row has 0 action buttons (got ${settledActionBtns})`);
    browserPassed++; // U14

    // U16: Settlement modal opens lines + cashReturn + disabled until diff === 0.00
    await openRow.locator('button:has-text("تسوية")').click();
    await page.waitForTimeout(200);
    const submitSettleBtn = page.locator('[data-testid="submit-settle-btn"]');
    assert(await submitSettleBtn.isDisabled(), 'U16: settle submit disabled initially when diff != 0');
    const expSelectOpts = await page.locator('select[name="settleLineAccount_0"] option').allTextContents();
    assert(
      expSelectOpts.some((t: string) => t.includes('5101')) && !expSelectOpts.some((t: string) => t.includes('1101')),
      `U16: expense line select shows expense accounts only (${expSelectOpts.join(' | ')})`
    );
    await page.locator('select[name="settleLineAccount_0"]').selectOption('acc-exp-1');
    await page.locator('input[name="settleLineAmount_0"]').fill('420');
    await page.locator('input[name="cashReturn"]').fill('80');
    await page.waitForTimeout(150);
    const diffText = (await page.locator('[data-testid="settle-diff-counter"]').textContent())?.trim();
    assert(diffText === '0.00', `U16: settle diff counter === 0.00 (got "${diffText}")`);
    assert(await submitSettleBtn.isEnabled(), 'U16: settle submit enabled when diff === 0.00');
    await page.locator('button:has-text("إلغاء")').last().click();
    await page.waitForTimeout(150);
    browserPassed++; // U16

    // U19: Open custody balances tab displays Employee / Count / Total from shim
    await page.locator('[role="tab"]', { hasText: /^أرصدة العهد المفتوحة$/ }).click();
    await page.waitForTimeout(250);
    const openRowText = await page.locator('table tbody tr').first().textContent();
    assert(
      Boolean(openRowText && openRowText.includes('ahmed_emp') && openRowText.includes('500.00')),
      `U19: Open custodies summary renders non-empty employee/count/total (${openRowText})`
    );
    browserPassed++; // U19

    // U20: Click custody row -> opens movements drawer with journal entry numbers and movement rows
    await page.locator('[role="tab"]', { hasText: /^العهد$/ }).click();
    await page.waitForTimeout(200);
    await page.locator('tr[data-custody-status="settled"]').first().locator('td').first().click();
    await page.waitForTimeout(350);
    const drawer = page.locator('[data-testid="custody-movements-drawer"]');
    await drawer.waitFor({ state: 'visible', timeout: 5000 });
    const drawerText = (await drawer.textContent()) || '';
    assert(
      drawerText.includes('JE-2026-0030') &&
        drawerText.includes('JE-2026-0035') &&
        drawerText.includes('صرف عهدة') &&
        drawerText.includes('تسوية مصروف'),
      'U20: Custody movements drawer displays JE numbers & movements rows'
    );
    await drawer.locator('button:has-text("إغلاق")').click();
    await page.waitForTimeout(150);
    browserPassed++; // U20

    // U17: CompanySettingsPanel displays حساب ذمة عهد الموظفين
    await page.locator('aside button:has-text("إعدادات الشركة")').first().click();
    await page.waitForTimeout(350);
    const custodyFieldLabel = page.locator('label:has-text("حساب ذمة عهد الموظفين")');
    await custodyFieldLabel.waitFor({ state: 'visible', timeout: 5000 });
    assert(await custodyFieldLabel.isVisible(), 'U17: CompanySettingsPanel shows "حساب ذمة عهد الموظفين" field');
    browserPassed++; // U17

    // U18: ConfigPlatformPanel displays option "ربط عهد الموظفين بالدليل" and structured form
    currentProfile = { role: 'platform_admin', username: 'platform_admin_verify', permissions: currentProfile.permissions };
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('aside button:has-text("منصة الإعدادات")').first().click();
    await page.waitForTimeout(350);
    const custodyOpt = page.locator('option', { hasText: 'ربط عهد الموظفين بالدليل' }).first();
    assert((await custodyOpt.count()) > 0, 'U18: ConfigPlatformPanel includes "ربط عهد الموظفين بالدليل" option');
    await page.locator('select:has(option[value="accounting.custody_mapping"])').selectOption('accounting.custody_mapping');
    await page.waitForTimeout(350);
    assert(
      await page.locator('h5:has-text("Custody Mapping Form")').isVisible(),
      'U18: ConfigPlatformPanel shows structured form for accounting.custody_mapping'
    );
    browserPassed++; // U18

    // U15 + M5: company_user without custody:approve/disburse/cash:write
    currentProfile = {
      role: 'company_user',
      username: 'employee_only',
      permissions: ['cash:read', 'custody:request'],
    };
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('aside button:has-text("الخزينة والعهد")').first().waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('aside button:has-text("الخزينة والعهد")').first().click();
    await page.waitForTimeout(350);

    // Tabs still visible!
    assert(await page.locator('[role="tab"]', { hasText: /^الصناديق$/ }).isVisible(), 'U15: company_user sees الصناديق tab');
    assert(await page.locator('[role="tab"]', { hasText: /^العهد$/ }).isVisible(), 'U15: company_user sees العهد tab');
    assert((await page.locator('button:has-text("صندوق جديد")').count()) === 0, 'U15/M5: company_user does NOT see صندوق جديد');

    await page.locator('[role="tab"]', { hasText: /^العهد$/ }).click();
    await page.waitForTimeout(300);
    const rowsCount = await page.locator('table tbody tr[data-custody-status]').count();
    assert(rowsCount > 0, `U15: company_user sees custody rows (${rowsCount})`);
    assert((await page.locator('table tbody button:has-text("اعتماد")').count()) === 0, 'U15/M5: company_user sees 0 اعتماد buttons');
    assert((await page.locator('table tbody button:has-text("صرف")').count()) === 0, 'U15/M5: company_user sees 0 صرف buttons');
    browserPassed++; // U15

    // U21: Zero console.error & zero pageerror across U8..U20
    assert(consoleErrors.length === 0, `U21: Zero console errors across U8..U20 (got ${consoleErrors.join('; ')})`);
    assert(pageErrors.length === 0, `U21: Zero page errors across U8..U20 (got ${pageErrors.join('; ')})`);
    browserPassed++; // U21

    // M5 negative check: Prove 403 Arabic response text from server when unauthorized endpoint called
    const server403Text = await page.evaluate(async () => {
      const res = await fetch('/api/cash/custodies/cus-pending-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: 'comp-cash-ui-1' }),
      });
      const data = await res.json();
      return { status: res.status, message: data.message };
    });
    assert(
      server403Text.status === 403 && Boolean(server403Text.message && server403Text.message.includes('صلاحية')),
      `M5: Server 403 Arabic error text returned verbatim ("${server403Text.message}")`
    );

    // M4 negative + lifecycle check as company_admin: approve -> disburse -> settle CUS-0001 + Arabic 400 verbatim
    currentProfile = {
      role: 'company_admin',
      username: 'company_admin_verify',
      permissions: ['cash:read', 'cash:write', 'custody:request', 'custody:approve', 'custody:disburse', 'custody:settle'],
    };
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('aside button:has-text("الخزينة والعهد")').first().click();
    await page.waitForTimeout(300);
    await page.locator('[role="tab"]', { hasText: /^العهد$/ }).click();
    await page.waitForTimeout(300);

    const cus1Row = page.locator('table tbody tr:has-text("CUS-0001")');
    await cus1Row.locator('button:has-text("رفض")').click();
    await page.waitForTimeout(150);
    await page.locator('textarea[name="rejectReason"]').evaluate((el: HTMLTextAreaElement) => {
      el.minLength = 1; // bypass HTML5 minLength to verify server 400 Arabic error renders verbatim
    });
    await page.locator('textarea[name="rejectReason"]').fill('قصير');
    await page.locator('button:has-text("تأكيد الرفض")').click();
    await page.waitForTimeout(250);
    const alertText = (await page.locator('[role="alert"]').textContent()) || '';
    assert(alertText.includes('سبب الرفض مطلوب'), `M4 server error shown verbatim: "${alertText}"`);
    await page.locator('button:has-text("تراجع")').click();
    await page.waitForTimeout(150);

    await cus1Row.locator('button:has-text("اعتماد")').click();
    await page.waitForTimeout(250);
    assert((await cus1Row.getAttribute('data-custody-status')) === 'approved', 'M4: CUS-0001 transitioned pending -> approved');
    await cus1Row.locator('button:has-text("صرف")').click();
    await page.waitForTimeout(250);
    assert((await cus1Row.getAttribute('data-custody-status')) === 'open', 'M4: CUS-0001 transitioned approved -> open');
    await cus1Row.locator('button:has-text("تسوية")').click();
    await page.waitForTimeout(200);
    await page.locator('select[name="settleLineAccount_0"]').selectOption('acc-exp-1');
    await page.locator('input[name="settleLineAmount_0"]').fill('700');
    await page.locator('input[name="cashReturn"]').fill('50');
    await page.waitForTimeout(100);
    await page.locator('[data-testid="submit-settle-btn"]').click();
    await page.waitForTimeout(300);
    assert((await cus1Row.getAttribute('data-custody-status')) === 'settled', 'M4: CUS-0001 transitioned open -> settled');
    assert(pageErrors.length === 0, 'M1..M5: Zero uncaught page errors during interactive lifecycle');

    // =========================================================================
    // WP-7b: Vouchers & Register Movements & Employee Custody Detail (T1..T10)
    // =========================================================================
    console.log('\n=== WP-7b Browser Verification T1..T10 ===');
    let tPassed = 0;

    // Reset console/page error buffers for T1..T10 strict tracking
    consoleErrors.length = 0;
    pageErrors.length = 0;

    // T1: Tabs «سندات» & «حركة صندوق» visible inside tablist after the 3 base tabs and clickable
    const tabLabels = await page.locator('[role="tablist"] [role="tab"]').allTextContents();
    const trimmedLabels = tabLabels.map((s: string) => s.trim());
    const idxOpenBal = trimmedLabels.indexOf('أرصدة العهد المفتوحة');
    const idxVouchers = trimmedLabels.indexOf('سندات');
    const idxMovements = trimmedLabels.indexOf('حركة صندوق');
    assert(
      idxOpenBal === 2 && idxVouchers === 3 && idxMovements === 4,
      `T1: Tabs "سندات" & "حركة صندوق" visible after 3 base tabs (${trimmedLabels.join(' | ')})`
    );
    tPassed++; // T1

    // T2: Clicking «سندات» renders «سندات قبض»/«سندات صرف» toggle & switching changes heading/table rows
    await page.locator('[role="tab"]', { hasText: /^سندات$/ }).click();
    await page.waitForTimeout(250);
    const receiptToggle = page.locator('button:has-text("سندات قبض")');
    const paymentToggle = page.locator('button:has-text("سندات صرف")');
    assert((await receiptToggle.isVisible()) && (await paymentToggle.isVisible()), 'T2: Receipt/Payment toggle buttons visible');
    const headingBefore = (await page.locator('[data-testid="vouchers-heading"]').textContent())?.trim() || '';
    assert(headingBefore.includes('القبض'), `T2: Initial heading shows receipt vouchers ("${headingBefore}")`);
    assert(await page.locator('[data-testid="vouchers-table"] tbody tr:has-text("CRV-0001")').isVisible(), 'T2: Receipt voucher row CRV-0001 visible');

    await paymentToggle.click();
    await page.waitForTimeout(200);
    const headingAfter = (await page.locator('[data-testid="vouchers-heading"]').textContent())?.trim() || '';
    assert(headingAfter.includes('الصرف'), `T2: Switched heading shows payment vouchers ("${headingAfter}")`);
    assert(await page.locator('[data-testid="vouchers-table"] tbody tr:has-text("CPV-0001")').isVisible(), 'T2: Payment voucher row CPV-0001 visible');
    await receiptToggle.click();
    await page.waitForTimeout(200);
    tPassed++; // T2

    // T3: Vouchers table shows 7 data columns + «رقم القيد» and non-empty cells
    const vchHeaders = await page.locator('[data-testid="vouchers-table"] thead th').allTextContents();
    const expectedVchCols = ['رقم السند', 'التاريخ', 'النوع', 'الصندوق', 'الطرف', 'المبلغ', 'الحالة', 'رقم القيد'];
    const allVchColsPresent = expectedVchCols.every((col) => vchHeaders.some((h: string) => h.includes(col)));
    const firstPostedCells = await page.locator('[data-testid="vouchers-table"] tbody tr[data-voucher-status="posted"] td').allTextContents();
    const nonEmptyCells = firstPostedCells.slice(0, 8).every((c: string) => c.trim().length > 0);
    assert(allVchColsPresent && nonEmptyCells, `T3: Vouchers table headers & non-empty cells verified (${vchHeaders.join(' | ')})`);
    tPassed++; // T3

    // T4: «سند جديد» opens modal with all 7 inputs & non-empty contraAccountId options from shim
    await page.locator('button:has-text("سند جديد")').click();
    await page.waitForTimeout(200);
    const vModal = page.locator('[data-testid="create-voucher-modal"]');
    await vModal.waitFor({ state: 'visible', timeout: 5000 });
    const has7Inputs =
      (await vModal.locator('select[name="voucherKind"]').isVisible()) &&
      (await vModal.locator('input[name="voucherDate"]').isVisible()) &&
      (await vModal.locator('select[name="voucherRegisterId"]').isVisible()) &&
      (await vModal.locator('input[name="voucherAmount"]').isVisible()) &&
      (await vModal.locator('select[name="contraAccountId"]').isVisible()) &&
      (await vModal.locator('input[name="voucherReference"]').isVisible()) &&
      (await vModal.locator('input[name="voucherMemo"]').isVisible());
    const contraOpts = await vModal.locator('select[name="contraAccountId"] option').allTextContents();
    assert(
      has7Inputs && contraOpts.some((t: string) => t.includes('4101')),
      `T4: New voucher modal renders all 7 fields & contraAccountId options (${contraOpts.join(' | ')})`
    );
    await vModal.locator('button:has-text("إلغاء")').click();
    await page.waitForTimeout(150);
    tPassed++; // T4

    // T5: draft row displays «ترحيل» & «إلغاء»; posted row displays neither
    const draftVoucherRow = page.locator('[data-testid="vouchers-table"] tbody tr[data-voucher-status="draft"]').first();
    const postedVoucherRow = page.locator('[data-testid="vouchers-table"] tbody tr[data-voucher-status="posted"]').first();
    assert(
      (await draftVoucherRow.locator('button:has-text("ترحيل")').isVisible()) &&
        (await draftVoucherRow.locator('button:has-text("إلغاء")').isVisible()) &&
        (await postedVoucherRow.locator('button:has-text("ترحيل")').count()) === 0 &&
        (await postedVoucherRow.locator('button:has-text("إلغاء")').count()) === 0,
      'T5: Draft voucher row shows ترحيل & إلغاء while posted row hides both'
    );
    tPassed++; // T5

    // T6: posted row displays «العكس المحاسبي» hint & journal entry link/number
    const postedRowText = (await postedVoucherRow.textContent()) || '';
    const jeLinkVisible = await postedVoucherRow.locator('a:has-text("JE-")').isVisible();
    assert(
      postedRowText.includes('العكس المحاسبي') && jeLinkVisible,
      `T6: Posted voucher row displays العكس المحاسبي hint and JE link ("${postedRowText}")`
    );
    tPassed++; // T6

    // T7: «حركة صندوق» shows register selector, from/to dates, and 7-column table with non-empty values
    await page.locator('[role="tab"]', { hasText: /^حركة صندوق$/ }).click();
    await page.waitForTimeout(300);
    const movFilterVisible =
      (await page.locator('select[name="movementRegisterId"]').isVisible()) &&
      (await page.locator('input[name="movementFrom"]').isVisible()) &&
      (await page.locator('input[name="movementTo"]').isVisible());
    const movHeaders = await page.locator('[data-testid="register-movements-table"] thead th').allTextContents();
    const expectedMovCols = ['التاريخ', 'النوع', 'الوارد', 'الصادر', 'المرجع', 'المستخدم', 'رقم القيد'];
    const allMovColsPresent = expectedMovCols.every((c) => movHeaders.some((h: string) => h.includes(c)));
    const firstMovRowCells = await page.locator('[data-testid="register-movements-table"] tbody tr').first().locator('td').allTextContents();
    const movRowNonEmpty = firstMovRowCells.length === 7 && firstMovRowCells.every((c: string) => c.trim().length > 0);
    assert(
      movFilterVisible && allMovColsPresent && movRowNonEmpty,
      `T7: Register movements filter bar & 7 columns verified (${firstMovRowCells.join(' | ')})`
    );
    tPassed++; // T7

    // T8: «تفصيل الموظف» button on «أرصدة العهد المفتوحة» opens modal with employee custody movements table
    await page.locator('[role="tab"]', { hasText: /^أرصدة العهد المفتوحة$/ }).click();
    await page.waitForTimeout(250);
    const empDetailBtn = page.locator('button:has-text("تفصيل الموظف")').first();
    await empDetailBtn.waitFor({ state: 'visible', timeout: 5000 });
    await empDetailBtn.click();
    await page.waitForTimeout(300);
    const empModal = page.locator('[data-testid="employee-custody-modal"]');
    await empModal.waitFor({ state: 'visible', timeout: 5000 });
    const empTableRows = await empModal.locator('[data-testid="employee-custody-table"] tbody tr').count();
    const empModalText = (await empModal.textContent()) || '';
    assert(
      empTableRows > 0 && empModalText.includes('CUS-'),
      `T8: Employee detail modal displays custody movements table (${empTableRows} rows)`
    );
    await empModal.locator('button:has-text("إغلاق")').click();
    await page.waitForTimeout(150);
    tPassed++; // T8

    // T9: Posting draft payment voucher exceeding register balance returns Arabic 400 -> rendered verbatim inside vouchers alert
    await page.locator('[role="tab"]', { hasText: /^سندات$/ }).click();
    await page.waitForTimeout(200);
    await page.locator('button:has-text("سندات صرف")').click();
    await page.waitForTimeout(200);
    expectingIntentionalHttpError = true;
    await page.locator('[data-testid="vouchers-table"] tbody tr[data-voucher-status="draft"] button:has-text("ترحيل")').first().click();
    await page.waitForTimeout(300);
    expectingIntentionalHttpError = false;
    const voucherErrText = (await page.locator('[data-testid="vouchers-inline-error"]').textContent()) || '';
    assert(
      voucherErrText.includes('رصيد الصندوق') && voucherErrText.includes('غير كافٍ'),
      `T9: Server Arabic error rendered verbatim inside vouchers inline alert ("${voucherErrText}")`
    );
    tPassed++; // T9

    // T10: Zero console.error & zero pageerror across T1..T9
    assert(
      consoleErrors.length === 0 && pageErrors.length === 0,
      `T10: Zero console.error (${consoleErrors.join('; ')}) and zero pageerror (${pageErrors.join('; ')}) across T1..T9`
    );
    tPassed++; // T10

    console.log(
      `\n[PASS] verifyCashCustodyUi1 COMPLETE: Static ${staticCount}/7 | Browser ${browserPassed}/14 (U8..U21) | M1..M5 verified | Vouchers & Reports T1..T10: ${tPassed}/10`
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[FAIL] verifyCashCustodyUi1 failed:', err);
  process.exit(1);
});
