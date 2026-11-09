import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';

console.log('--- Running Executor Lifecycle Verification (F10-4) ---');

async function runTests() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Executor lifecycle tests BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  // 1. Concurrent requests to getDefaultExecutor share single instance
  const promises = Array.from({ length: 10 }, () => getDefaultExecutor());
  const executors = await Promise.all(promises);
  const first = executors[0];
  const allSame = executors.every((e) => e === first);
  await check('Concurrent getDefaultExecutor calls share the exact same instance', allSame);

  // 2. Health check works
  const health = await first?.health();
  await check('Executor health check succeeds', Boolean(health?.ok));

  // 3. Close all executors
  await closeAllExecutors();
  await check('closeAllExecutors completes successfully', true);

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
