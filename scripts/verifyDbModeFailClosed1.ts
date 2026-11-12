import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { TenantDatabaseResolver } from '../src/server/db/TenantDatabaseResolver.js';

async function run() {
  console.log('=== Verifying Database Mode Fail-Closed Guard (WP-1) ===');
  let passed = 0;
  let failed = 0;

  function check(name: string, condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${name}: ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name}: ${message}`);
      failed++;
    }
  }

  const read = (p: string) => fs.readFileSync(path.resolve(p), 'utf8');

  // Static checks
  const typesSrc = read('src/server/db/types.ts');
  check('S1', !typesSrc.includes("'hybrid'") && !typesSrc.includes('"hybrid"'), 'types.ts does not contain hybrid');
  check('S2', typesSrc.includes('DATABASE_MODES'), 'types.ts exports DATABASE_MODES');

  const resolverSrc = read('src/server/db/TenantDatabaseResolver.ts');
  check('S3', !resolverSrc.includes("'hybrid'") || resolverSrc.includes("mode 'hybrid' is not supported"),
    'TenantDatabaseResolver rejects hybrid as acceptable mode');

  const indexSrc = read('src/server/db/index.ts');
  check('S4', indexSrc.includes('TENANT_DB_ROUTE_MISSING'), 'index.ts contains TENANT_DB_ROUTE_MISSING guard');
  check('S5', indexSrc.includes("ref.mode === 'central'"), 'index.ts fallback requires ref.mode === central');

  // Runtime checks
  const origDbMode = process.env.DB_MODE;

  try {
    // T1: per_company without route throws TENANT_DB_ROUTE_MISSING
    process.env.DB_MODE = 'per_company';
    let t1Threw = false;
    try {
      const resolver = new TenantDatabaseResolver();
      resolver.resolve('company_123');
    } catch (e: any) {
      t1Threw = e.message.includes('TENANT_DB_ROUTE_MISSING');
    }
    check('T1', t1Threw, 'per_company without route throws TENANT_DB_ROUTE_MISSING');

    // T2: per_company with setTenantRoute resolves connectionKey
    process.env.DB_MODE = 'per_company';
    const resolverT2 = new TenantDatabaseResolver();
    resolverT2.setTenantRoute('company_123', {
      companyId: 'company_123',
      mode: 'per_company',
      connectionKey: 'tenant_company_123',
    });
    const resT2 = resolverT2.resolve('company_123');
    check('T2', resT2.connectionKey === 'tenant_company_123', 'per_company with route resolves custom connectionKey');

    // T3: on_prem without route throws TENANT_DB_ROUTE_MISSING
    process.env.DB_MODE = 'on_prem';
    let t3Threw = false;
    try {
      const resolver = new TenantDatabaseResolver();
      resolver.resolve('company_123');
    } catch (e: any) {
      t3Threw = e.message.includes('TENANT_DB_ROUTE_MISSING');
    }
    check('T3', t3Threw, 'on_prem without route throws TENANT_DB_ROUTE_MISSING');

    // T4: hybrid throws DB_MODE_INVALID on constructor
    process.env.DB_MODE = 'hybrid';
    let t4Threw = false;
    try {
      new TenantDatabaseResolver();
    } catch (e: any) {
      t4Threw = e.message.includes('DB_MODE_INVALID');
    }
    check('T4', t4Threw, 'DB_MODE=hybrid throws DB_MODE_INVALID');

    // T5: garbage throws DB_MODE_INVALID on constructor
    process.env.DB_MODE = 'garbage';
    let t5Threw = false;
    try {
      new TenantDatabaseResolver();
    } catch (e: any) {
      t5Threw = e.message.includes('DB_MODE_INVALID');
    }
    check('T5', t5Threw, 'DB_MODE=garbage throws DB_MODE_INVALID');

    // T6: no DB_MODE defaults to central and connectionKey=default
    delete process.env.DB_MODE;
    const resolverT6 = new TenantDatabaseResolver();
    const resT6 = resolverT6.resolve('company_123');
    check('T6', resT6.mode === 'central' && resT6.connectionKey === 'default',
      'empty DB_MODE defaults to central mode and default connectionKey');

  } finally {
    if (origDbMode !== undefined) {
      process.env.DB_MODE = origDbMode;
    } else {
      delete process.env.DB_MODE;
    }
  }

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
