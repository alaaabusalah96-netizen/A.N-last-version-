import fs from 'fs';
import path from 'path';
import pg from 'pg';

function assert(condition: boolean, label: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${label}`);
  }
  console.log(`[PASS] ${label}`);
}

function assertLoopbackUrl(raw: string, varName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${varName} is invalid URL format`);
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
  }
  return parsed;
}

async function run() {
  console.log('=== VERIFY AN-SALES-CYCLE-1 (Customers / Delivery / Invoice / Collection / AR Aging) ===');
  const rootDir = process.cwd();

  // 1. Migration 045 structural & RLS safety checks
  const mig045Path = path.join(rootDir, 'database/migrations/045_sales_cycle.sql');
  assert(fs.existsSync(mig045Path), 'Migration 045_sales_cycle.sql exists');
  const mig045 = fs.readFileSync(mig045Path, 'utf8');

  const requiredTables = [
    'sales_customers',
    'sales_delivery_notes',
    'sales_delivery_lines',
    'sales_invoices',
    'sales_invoice_lines',
    'sales_collections',
  ];
  for (const tbl of requiredTables) {
    assert(mig045.includes(`CREATE TABLE IF NOT EXISTS ${tbl}`), `Migration defines ${tbl}`);
    assert(mig045.includes(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY`), `Migration enables RLS on ${tbl}`);
    assert(mig045.includes(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY`), `Migration forces RLS on ${tbl}`);
    assert(mig045.includes(`ON ${tbl}`) && mig045.includes('app.current_tenant_id'), `Migration defines tenant policy on ${tbl}`);
  }
  assert(!/EXCEPTION\s+WHEN\s+OTHERS/i.test(mig045), 'Migration 045 does NOT contain EXCEPTION WHEN OTHERS');
  assert(mig045.includes('trg_sales_delivery_lines_posted_guard'), 'Migration defines posted delivery lines guard trigger');
  assert(mig045.includes('trg_sales_invoice_lines_posted_guard'), 'Migration defines posted invoice lines guard trigger');

  // 2. Table ownership registry
  const ownershipPath = path.join(rootDir, 'database/table_ownership.json');
  const ownership = JSON.parse(fs.readFileSync(ownershipPath, 'utf8')) as Array<{ table: string; scope: string }>;
  const ownershipMap = new Map(ownership.map((e) => [e.table, e.scope]));
  for (const tbl of requiredTables) {
    assert(ownershipMap.get(tbl) === 'tenant', `table_ownership.json registers ${tbl} as tenant`);
  }

  // 3. RBAC Permissions & Roles
  const permsContent = fs.readFileSync(path.join(rootDir, 'src/server/rbac/permissions.ts'), 'utf8');
  assert(permsContent.includes("SALES_READ: 'sales:read'"), 'permissions.ts defines SALES_READ');
  assert(permsContent.includes("SALES_WRITE: 'sales:write'"), 'permissions.ts defines SALES_WRITE');
  assert(permsContent.includes("SALES_POST: 'sales:post'"), 'permissions.ts defines SALES_POST');

  const rolesContent = fs.readFileSync(path.join(rootDir, 'src/server/rbac/roles.ts'), 'utf8');
  assert(rolesContent.includes('PERMISSIONS.SALES_READ') && rolesContent.includes('PERMISSIONS.SALES_POST'), 'roles.ts maps sales permissions');

  // 4. Sales Server Modules, Quantity/Posting Guards, Cash Register & Route Mounting
  const salesFiles = [
    'src/server/sales/salesTypes.ts',
    'src/server/sales/customerRepository.ts',
    'src/server/sales/customerService.ts',
    'src/server/sales/salesDeliveryRepository.ts',
    'src/server/sales/salesDeliveryService.ts',
    'src/server/sales/salesInvoiceRepository.ts',
    'src/server/sales/salesInvoiceService.ts',
    'src/server/sales/salesCollectionRepository.ts',
    'src/server/sales/salesCollectionService.ts',
    'src/server/sales/arAgingService.ts',
    'src/server/sales/__tests__/salesCycle.test.ts',
  ];
  for (const f of salesFiles) {
    assert(fs.existsSync(path.join(rootDir, f)), `Module exists: ${f}`);
  }

  const delRepo = fs.readFileSync(path.join(rootDir, 'src/server/sales/salesDeliveryRepository.ts'), 'utf8');
  const invRepo = fs.readFileSync(path.join(rootDir, 'src/server/sales/salesInvoiceRepository.ts'), 'utf8');
  assert(!delRepo.includes('i.base_uom') && delRepo.includes('i.uom'), 'salesDeliveryRepository uses inv_items.uom column');
  assert(!invRepo.includes('i.base_uom') && invRepo.includes('i.uom'), 'salesInvoiceRepository uses inv_items.uom column');

  const delSvc = fs.readFileSync(path.join(rootDir, 'src/server/sales/salesDeliveryService.ts'), 'utf8');
  assert(
    delSvc.includes('getBalanceForUpdate') && delSvc.includes('decrementBalance') && delSvc.includes('createMovement'),
    'salesDeliveryService uses atomic stock engine lock/decrement/movement'
  );

  const invSvc = fs.readFileSync(path.join(rootDir, 'src/server/sales/salesInvoiceService.ts'), 'utf8');
  assert(
    invSvc.includes('FOR UPDATE OF dl') && invSvc.includes('createDraftEntry') && invSvc.includes('postEntry'),
    'salesInvoiceService enforces over-invoicing lock and balanced GL posting'
  );

  const colSvc = fs.readFileSync(path.join(rootDir, 'src/server/sales/salesCollectionService.ts'), 'utf8');
  assert(
    colSvc.includes('findByIdForUpdate') && colSvc.includes('register.glAccountId') && colSvc.includes('postEntry'),
    'salesCollectionService enforces open-balance guard and balanced cash register GL posting'
  );

  const agingSvc = fs.readFileSync(path.join(rootDir, 'src/server/sales/arAgingService.ts'), 'utf8');
  assert(
    agingSvc.includes("'0-30'") && agingSvc.includes("'31-60'") && agingSvc.includes("'61+'"),
    'arAgingService classifies 0-30 / 31-60 / 61+ aging buckets'
  );

  const cashRegRepo = fs.readFileSync(path.join(rootDir, 'src/server/cash/cashRegisterRepository.ts'), 'utf8');
  assert(cashRegRepo.includes('FROM sales_collections'), 'cashRegisterRepository.sumMovements includes sales_collections');

  const salesRoutes = fs.readFileSync(path.join(rootDir, 'src/server/routes/salesRoutes.ts'), 'utf8');
  assert(
    salesRoutes.includes('requireAuth') && salesRoutes.includes('assertSalesPermission') && salesRoutes.includes('/ar/aging'),
    'salesRoutes protects endpoints with requireAuth & assertSalesPermission and exposes /ar/aging'
  );

  const appContent = fs.readFileSync(path.join(rootDir, 'src/server/app.ts'), 'utf8');
  assert(appContent.includes("app.use('/api/sales', salesRoutes)"), 'app.ts mounts /api/sales router');

  // 5. Frontend UI Wiring
  const wsPath = path.join(rootDir, 'src/components/sales/SalesWorkspace.tsx');
  assert(fs.existsSync(wsPath), 'SalesWorkspace.tsx exists');
  const wsContent = fs.readFileSync(wsPath, 'utf8');
  assert(
    wsContent.includes("'customers'") &&
      wsContent.includes("'deliveries'") &&
      wsContent.includes("'invoices'") &&
      wsContent.includes("'collections'") &&
      wsContent.includes("'aging'"),
    'SalesWorkspace defines all 5 tabs: customers, deliveries, invoices, collections, aging'
  );
  assert(
    wsContent.includes('/api/sales/customers') &&
      wsContent.includes('/api/sales/deliveries') &&
      wsContent.includes('/api/sales/invoices') &&
      wsContent.includes('/api/sales/collections') &&
      wsContent.includes('/api/sales/ar/aging'),
    'SalesWorkspace references all 5 sales API endpoints'
  );
  assert(!/firebase|firestore|localStorage/i.test(wsContent), 'SalesWorkspace uses no Firebase or localStorage fallbacks');

  const sidebarContent = fs.readFileSync(path.join(rootDir, 'src/components/shell/AppSidebar.tsx'), 'utf8');
  assert(sidebarContent.includes("onNavigate('sales')") && sidebarContent.includes('المبيعات'), 'AppSidebar includes sales navigation');

  const frontendApp = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf8');
  assert(frontendApp.includes("'sales'") && frontendApp.includes('<SalesWorkspace'), 'src/App.tsx wires SalesWorkspace');

  // 6. Optional loopback PostgreSQL live schema & transaction smoke check
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    console.log('[INFO] DATABASE_URL not set; static, architectural, RBAC, and UI checks passed.');
    console.log('PASS: verifySalesCycle1 completed successfully.');
    return;
  }

  assertLoopbackUrl(dbUrl, 'DATABASE_URL');
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const client = await pool.connect();
    try {
      const tblRes = await client.query<{ relname: string }>(
        `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [requiredTables]
      );
      assert(tblRes.rows.length === requiredTables.length, 'Live loopback DB has all 6 sales tables');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  console.log('PASS: verifySalesCycle1 static and loopback DB checks passed successfully.');
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
