import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { assertNoDataApiExposure } from '../src/server/db/dataApiGuard.js';

console.log('--- Running Data API Guard Verification (F10-5) ---');

async function runTests() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Data API guard tests BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Executor unavailable.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const violations = await assertNoDataApiExposure(executor);
  await check('assertNoDataApiExposure detects no unauthorized table exposure on Data API roles', violations.length === 0, violations.length > 0 ? violations.join('; ') : undefined);

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
