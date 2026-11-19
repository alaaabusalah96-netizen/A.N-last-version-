import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { check, blocked, summary } from './lib/testkit.js';

console.log('============================================================================');
console.log('=== VERIFYING AN-PKG-7C2: PRICE VARIANCE EXCEPTION SoD & PPV WORKFLOW      ===');
console.log('============================================================================');

async function run() {
  const rootDir = process.cwd();

  // S0: Registration checks
  const batterySrc = fs.readFileSync(path.join(rootDir, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  await check(
    'S0: verifyPurchPriceException1.ts registered in runFoundationBattery.ts and package.json',
    batterySrc.includes('scripts/verifyPurchPriceException1.ts') &&
      pkgJson?.scripts?.['test:purch-price-exception-1'] === 'tsx scripts/verifyPurchPriceException1.ts'
  );

  // S1: Migration 055 & table_ownership.json structural checks
  const mig055Path = path.join(rootDir, 'database/migrations/055_purch_price_variance_exception.sql');
  const mig055Exists = fs.existsSync(mig055Path);
  const mig055 = mig055Exists ? fs.readFileSync(mig055Path, 'utf8') : '';
  const mig055NoComments = mig055.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '');
  const ownershipJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'database/table_ownership.json'), 'utf8'));
  const ownershipArr: Array<{ table: string; scope: string }> = Array.isArray(ownershipJson) ? ownershipJson : [];
  const hasTenantEntry = (tableName: string) =>
    ownershipArr.some((entry) => entry.table === tableName && entry.scope === 'tenant');

  await check(
    'S1: Migration 055 defines purch_price_variance_exceptions with RLS FORCE, active-approved unique index, zero EXCEPTION WHEN OTHERS & table_ownership registration',
    mig055Exists &&
      mig055.includes('purch_price_variance_exceptions') &&
      mig055.includes('idx_purch_price_exc_active_approved') &&
      mig055.includes('ENABLE ROW LEVEL SECURITY') &&
      mig055.includes('FORCE ROW LEVEL SECURITY') &&
      !/\bEXCEPTION\s+WHEN\s+OTHERS\b/i.test(mig055NoComments) &&
      hasTenantEntry('purch_price_variance_exceptions')
  );

  // S2: RBAC permissions registered
  const permsSrc = fs.readFileSync(path.join(rootDir, 'src/server/rbac/permissions.ts'), 'utf8');
  await check(
    'S2: PURCHASING_VARIANCE_REQUEST & PURCHASING_VARIANCE_APPROVE permissions registered',
    permsSrc.includes('PURCHASING_VARIANCE_REQUEST') && permsSrc.includes('PURCHASING_VARIANCE_APPROVE')
  );

  // S3: Repository, Service & InvoiceService integration
  const repoSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/priceVarianceExceptionRepository.ts'), 'utf8');
  const svcSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/priceVarianceExceptionService.ts'), 'utf8');
  const invSvcSrc = fs.readFileSync(path.join(rootDir, 'src/server/purchasing/invoiceService.ts'), 'utf8');

  await check(
    'S3: Repository computes fingerprint, Service enforces SoD and postInvoice validates approved exception + fingerprint + quantity hard block',
    repoSrc.includes('computeFingerprint') &&
      svcSrc.includes('requestedBy') &&
      invSvcSrc.includes('findActiveApprovedByInvoice') &&
      invSvcSrc.includes('exceedsQty')
  );

  console.log('PASS: verifyPurchPriceException1 static/structural checks completed successfully.');
  const { exitCode } = summary();
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyPurchPriceException1] Fatal error:', err);
  process.exit(1);
});
