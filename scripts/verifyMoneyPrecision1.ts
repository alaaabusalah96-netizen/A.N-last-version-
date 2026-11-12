import fs from 'fs';
import path from 'path';
import {
  toMinorUnits,
  fromMinorUnits,
  sumMoney,
  isMoneyBalanced,
  toMoney,
  toDecimal,
} from '../src/server/lib/numeric.js';

async function run() {
  console.log('=== Verifying Money Precision Hardening (WP-2) ===');
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
  const accountingFiles = fs.readdirSync(path.resolve('src/server/accounting'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => read(path.join('src/server/accounting', f)))
    .join('\n');

  check('S1', !accountingFiles.includes('::float') && !accountingFiles.includes('::double precision'),
    'no ::float or ::double precision in src/server/accounting/');

  const journalRepoSrc = read('src/server/accounting/journalRepository.ts');
  check('S2', journalRepoSrc.includes('debit::text'), 'journalRepository.ts contains debit::text');

  const tbServiceSrc = read('src/server/accounting/trialBalanceService.ts');
  check('S3', tbServiceSrc.includes('toMinorUnits'), 'trialBalanceService.ts contains toMinorUnits');

  const numericSrc = read('src/server/lib/numeric.ts');
  check('S4',
    numericSrc.includes('export function toMinorUnits') &&
    numericSrc.includes('export function fromMinorUnits') &&
    numericSrc.includes('export function sumMoney') &&
    numericSrc.includes('export function isMoneyBalanced'),
    'numeric.ts exports toMinorUnits, fromMinorUnits, sumMoney, isMoneyBalanced'
  );

  check('S5', !numericSrc.includes('Math.round(n * factor) / factor'),
    'numeric.ts does not contain Math.round(n * factor) / factor');

  // Runtime checks
  check('T1', toMinorUnits('0.1') + toMinorUnits('0.2') === toMinorUnits('0.3'),
    'toMinorUnits(0.1) + toMinorUnits(0.2) === toMinorUnits(0.3)');

  check('T2', sumMoney(['0.1', '0.2']) === '0.30',
    'sumMoney([0.1, 0.2]) === 0.30');

  check('T3', toMoney(1.005) === 1.01,
    'toMoney(1.005) === 1.01');

  check('T4', toMoney(4.015) === 4.02,
    'toMoney(4.015) === 4.02');

  check('T5', toMinorUnits('9007199254740993', 0).toString() === '9007199254740993',
    'toMinorUnits handles > 2^53 integers without loss');

  check('T6', fromMinorUnits(BigInt(1234)) === '12.34',
    'fromMinorUnits(1234) === 12.34');

  check('T7', fromMinorUnits(BigInt(-1234)) === '-12.34',
    'fromMinorUnits(-1234) === -12.34');

  check('T8', isMoneyBalanced(['100.00', '0.10'], ['99.90', '0.20']) === true,
    'isMoneyBalanced checks balance via bigint');

  check('T9', toMinorUnits('abc') === BigInt(0),
    'toMinorUnits(abc) safely returns 0n without crashing or NaN');

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
