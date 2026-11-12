import fs from 'fs';
import path from 'path';
import { ConfigValidationService } from '../src/server/config-platform/configValidationService.js';
import { ValidationError } from '../src/server/http/errors.js';

async function run() {
  console.log('=== Verifying Config Platform Hardening (WP-4) ===');
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
  const valSrc = read('src/server/config-platform/configValidationService.ts');
  check('S1', valSrc.includes('SUPPORTED_JSON_TYPES'), 'configValidationService.ts defines SUPPORTED_JSON_TYPES');
  check('S2', !valSrc.includes('default:\n        return true'), 'matchesType does not return true by default');
  check('S3', valSrc.includes('Array.isArray(content)'), 'validateReferences checks Array.isArray(content)');
  check('S4', valSrc.includes('content[i]'), 'validateReferences indexes array items content[i]');

  const repoSrc = read('src/server/config-platform/configRepository.ts');
  check('S5', repoSrc.includes('pg_advisory_xact_lock'), 'configRepository.ts nextVersionNo acquires pg_advisory_xact_lock');

  const mig029Src = read('database/migrations/029_config_registry_company_fk_guard.sql');
  check('S6', mig029Src.includes('ON DELETE RESTRICT'), 'migration 029 sets config_registry FK ON DELETE RESTRICT');

  const waveASrc = read('scripts/verifyWaveACompletion1.ts');
  check('S7', !waveASrc.includes('no FAIL impact'), 'verifyWaveACompletion1.ts cleanup failure is not masked');

  // Runtime checks (no DB required)
  const validation = new ConfigValidationService();
  const C = '11111111-1111-1111-1111-111111111111';

  // T1: validateReferences descends into items array
  {
    const calls: string[] = [];
    const checker = async (_cid: string, p: string, _v: string) => { calls.push(p); };
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              inventory_account_id: { type: 'string' },
            },
          },
        },
      },
    };
    await validation.validateReferences(C, { items: [{ inventory_account_id: 'acc-1' }] }, schema, checker);
    check('T1', calls.includes('content.items[0].inventory_account_id'),
      'validateReferences checks account reference inside array item');
  }

  // T2: validateReferences with multiple array items checks [0] and [1]
  {
    const calls: string[] = [];
    const checker = async (_cid: string, p: string, _v: string) => { calls.push(p); };
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              inventory_account_id: { type: 'string' },
            },
          },
        },
      },
    };
    await validation.validateReferences(
      C,
      { items: [{ inventory_account_id: 'acc-1' }, { inventory_account_id: 'acc-2' }] },
      schema,
      checker
    );
    check('T2', calls.includes('content.items[0].inventory_account_id') && calls.includes('content.items[1].inventory_account_id'),
      'validateReferences checks all elements of an array');
  }

  // T3: matchesType on unsupported type returns false
  {
    const isMatched = (validation as any).matchesType('abc', 'bogusType');
    check('T3', isMatched === false, 'matchesType returns false for bogusType');
  }

  // T4: validateAgainstSchema with unsupported type throws ValidationError
  {
    let threw = false;
    try {
      validation.validateAgainstSchema({}, { type: 'bogusType' });
    } catch (e: any) {
      threw = e instanceof ValidationError;
    }
    check('T4', threw, 'validateAgainstSchema throws ValidationError on unsupported schema type');
  }

  // T5: matchesType integer checks
  {
    const nonInt = (validation as any).matchesType(1.5, 'integer');
    const isInt = (validation as any).matchesType(2, 'integer');
    check('T5', nonInt === false && isInt === true, 'matchesType distinguishes integers from non-integers');
  }

  // T6: validateAgainstSchema with additionalProperties=false rejects extra field
  {
    let threw = false;
    try {
      validation.validateAgainstSchema(
        { a: 1 },
        { type: 'object', additionalProperties: false, properties: {} }
      );
    } catch (e: any) {
      threw = e instanceof ValidationError;
    }
    check('T6', threw, 'validateAgainstSchema rejects extra property when additionalProperties=false');
  }

  // T7: deeply nested arrays: { a: [{ b: [{ inventory_account_id: 'X' }] }] }
  {
    const calls: string[] = [];
    const checker = async (_cid: string, p: string, _v: string) => { calls.push(p); };
    const schema = {
      type: 'object',
      properties: {
        a: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              b: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    inventory_account_id: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    };
    await validation.validateReferences(C, { a: [{ b: [{ inventory_account_id: 'X' }] }] }, schema, checker);
    check('T7', calls.includes('content.a[0].b[0].inventory_account_id'),
      'validateReferences handles nested arrays and objects');
  }

  // Optional Live DB checks if DATABASE_URL is set
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl && databaseUrl.trim()) {
    try {
      const { buildPgConfig } = await import('../src/server/db/connection.js');
      const pg = (await import('pg')).default;
      const client = new pg.Client(buildPgConfig(databaseUrl));
      await client.connect();
      try {
        const c1 = await client.query(
          `SELECT confdeltype FROM pg_constraint WHERE conname='config_registry_company_id_fkey'`
        );
        if (c1.rows.length > 0) {
          check('L1', c1.rows[0].confdeltype === 'r', 'live: config_registry_company_id_fkey has confdeltype=r');
        }
        const c2 = await client.query(
          `SELECT confdeltype FROM pg_constraint WHERE conname='config_drafts_company_id_fkey'`
        );
        if (c2.rows.length > 0) {
          check('L2', c2.rows[0].confdeltype === 'c', 'live: config_drafts_company_id_fkey has confdeltype=c');
        }
      } finally {
        await client.end();
      }
    } catch (e) {
      console.log('[INFO] Live DB check skipped or unmigrated:', (e as any)?.message);
    }
  }

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
