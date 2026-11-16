import fs from 'fs';
import path from 'path';
import { TenantDatabaseResolver } from '../src/server/db/TenantDatabaseResolver.js';

let passed = 0;
let failed = 0;

function check(id: string, condition: boolean, label: string) {
  if (condition) {
    console.log(`[PASS] ${id}: ${label}`);
    passed++;
  } else {
    console.error(`[FAIL] ${id}: ${label}`);
    failed++;
  }
}

function run() {
  console.log('=== VERIFY AN-DB-MODES-SCOPE-1 (Database Modes Production Support Statement) ===');
  const rootDir = process.cwd();

  const dbModesDocPath = path.join(rootDir, 'docs/ops/DB_MODES.md');
  check('D1', fs.existsSync(dbModesDocPath), 'docs/ops/DB_MODES.md exists');

  const doc = fs.existsSync(dbModesDocPath) ? fs.readFileSync(dbModesDocPath, 'utf8') : '';
  check(
    'D2',
    doc.includes('central') && (doc.includes('مدعوم رسميًا للإنتاج') || doc.includes('Officially Supported for Production')),
    'DB_MODES.md explicitly declares central as officially supported for production'
  );
  check(
    'D3',
    doc.includes('per_company') &&
      doc.includes('on_prem') &&
      (doc.includes('غير مدعوم للإنتاج') || doc.includes('NOT Supported for Production')),
    'DB_MODES.md explicitly declares per_company & on_prem as NOT supported for production'
  );
  check(
    'D4',
    doc.includes('hybrid') && doc.includes('DB_MODE_INVALID'),
    'DB_MODES.md explicitly documents hybrid architectural rejection'
  );

  const envExample = fs.readFileSync(path.join(rootDir, '.env.example'), 'utf8');
  check(
    'E1',
    envExample.includes('DB_MODE=central') && envExample.includes('per_company') && envExample.includes('on_prem'),
    '.env.example documents DB_MODE=central and non-production status of per_company/on_prem'
  );

  const origMode = process.env.DB_MODE;
  try {
    delete process.env.DB_MODE;
    const centralResolver = new TenantDatabaseResolver();
    const centralRef = centralResolver.resolve('comp-1');
    check('R1', centralRef.mode === 'central' && centralRef.connectionKey === 'default', 'Default DB_MODE resolves central');

    process.env.DB_MODE = 'per_company';
    const perCompResolver = new TenantDatabaseResolver();
    let perCompMissing = false;
    try {
      perCompResolver.resolve('comp-1');
    } catch (e) {
      perCompMissing = e instanceof Error && e.message.includes('TENANT_DB_ROUTE_MISSING');
    }
    check('R2', perCompMissing, 'per_company fails closed without route (TENANT_DB_ROUTE_MISSING)');

    process.env.DB_MODE = 'on_prem';
    const onPremResolver = new TenantDatabaseResolver();
    let onPremMissing = false;
    try {
      onPremResolver.resolve('comp-1');
    } catch (e) {
      onPremMissing = e instanceof Error && e.message.includes('TENANT_DB_ROUTE_MISSING');
    }
    check('R3', onPremMissing, 'on_prem fails closed without route (TENANT_DB_ROUTE_MISSING)');

    process.env.DB_MODE = 'hybrid';
    let hybridRejected = false;
    try {
      new TenantDatabaseResolver();
    } catch (e) {
      hybridRejected = e instanceof Error && e.message.includes('DB_MODE_INVALID');
    }
    check('R4', hybridRejected, 'hybrid throws DB_MODE_INVALID');
  } finally {
    if (origMode !== undefined) {
      process.env.DB_MODE = origMode;
    } else {
      delete process.env.DB_MODE;
    }
  }

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run();
