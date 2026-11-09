import { check, summary } from './lib/testkit.js';
import { resolveSslConfig, sanitizeConnectionString } from '../src/server/db/connection.js';
import { assertValidNodeEnv } from '../src/server/config/env.js';
import fs from 'fs';
import path from 'path';

console.log('--- Running DB Config & SSL Verification (F10-1) ---');

async function runTests() {
  // 1. Production default SSL -> rejectUnauthorized: true
  const prodDefault = resolveSslConfig({ NODE_ENV: 'production' }) as any;
  await check('Production default SSL enables rejectUnauthorized=true', prodDefault && prodDefault.rejectUnauthorized === true);

  // 2. Production DATABASE_SSL=disable -> throws
  let threwDisable = false;
  try {
    resolveSslConfig({ NODE_ENV: 'production', DATABASE_SSL: 'disable' });
  } catch {
    threwDisable = true;
  }
  await check('Production DATABASE_SSL=disable throws error', threwDisable);

  // 3. Production DATABASE_SSL_REJECT_UNAUTHORIZED=false -> throws
  let threwReject = false;
  try {
    resolveSslConfig({ NODE_ENV: 'production', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' });
  } catch {
    threwReject = true;
  }
  await check('Production DATABASE_SSL_REJECT_UNAUTHORIZED=false throws error', threwReject);

  // 4. CA text handling
  const fakeCa = '-----BEGIN CERTIFICATE-----\nFAKECA\n-----END CERTIFICATE-----';
  const sslWithCa = resolveSslConfig({ NODE_ENV: 'production', DATABASE_SSL_CA: fakeCa }) as any;
  await check('Production DATABASE_SSL_CA loads valid PEM certificate', sslWithCa && sslWithCa.ca === fakeCa);

  // 5. CA and CA_FILE both specified -> throws
  let threwBoth = false;
  try {
    resolveSslConfig({ NODE_ENV: 'production', DATABASE_SSL_CA: fakeCa, DATABASE_SSL_CA_FILE: 'somefile' });
  } catch {
    threwBoth = true;
  }
  await check('Both DATABASE_SSL_CA and CA_FILE throws error', threwBoth);

  // 6. Sanitize connection string
  const dirtyUrl = 'postgres://user:pass@host:5432/db?sslmode=require&sslrootcert=foo&application_name=test';
  const cleanUrl = sanitizeConnectionString(dirtyUrl);
  await check('sanitizeConnectionString removes sslmode and sslrootcert', !cleanUrl.includes('sslmode') && !cleanUrl.includes('sslrootcert') && cleanUrl.includes('application_name=test'));

  // 7. assertValidNodeEnv
  const origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'staging';
  let threwEnv = false;
  try {
    assertValidNodeEnv();
  } catch {
    threwEnv = true;
  } finally {
    process.env.NODE_ENV = origEnv;
  }
  await check('assertValidNodeEnv throws on invalid NODE_ENV', threwEnv);

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
