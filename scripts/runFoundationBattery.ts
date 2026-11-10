import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

console.log('========================================');
console.log('=== RUNNING FOUNDATION TEST BATTERY ===');
console.log('========================================');

// FIX 8 — TEST SAFETY: Refuse remote database connections in test battery
function assertLoopbackHost(urlStr: string | undefined, varName: string) {
  if (!urlStr || urlStr.trim() === '') return;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname;
    const allowedLoopback = ['localhost', '127.0.0.1', '::1'];
    if (!allowedLoopback.includes(host)) {
      console.error(`\n[FATAL SAFETY ERROR] Remote database host detected in ${varName} ('${host}'). Foundation test battery runs destructively and is strictly forbidden from executing against non-loopback databases.`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[FATAL SAFETY ERROR] Invalid URL provided in ${varName}:`, err);
    process.exit(1);
  }
}

assertLoopbackHost(process.env.DATABASE_URL, 'DATABASE_URL');
assertLoopbackHost(process.env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');

const scripts = [
  'scripts/verifyPublicAssets.ts',
  'scripts/verifyExecutorImports.ts',
  'scripts/verifyNoMemoryFallback.ts',
  'scripts/verifyFixRbacCompanies.ts',
  'scripts/verifyFixDbWiring.ts',
  'scripts/verifyRepair2.ts',
  'scripts/verifyPersistence.ts',
  'scripts/verifyTenantIsolation.ts',
  'scripts/verifyAuthSecurity.ts',
  'scripts/verifyRlsCoverage.ts',
  'scripts/verifyHttpSecurity.ts',
  'scripts/verifyRbacHttp.ts',
  'scripts/verifyMigrations.ts',
  'scripts/verifyCompanyAtomicity.ts',
  'scripts/verifyTenantHttp.ts',
  'scripts/verifyDbPrivileges.ts',
  'scripts/verifyForbiddenPatterns.ts',
  'scripts/verifyBatteryIntegrity.ts',
  'scripts/verifyDbConfig.ts',
  'scripts/verifyProvisioning.ts',
  'scripts/verifyRoleGuard.ts',
  'scripts/verifyExecutorLifecycle.ts',
  'scripts/verifyDataApiGuard.ts',
  'scripts/verifyTenantScopeMiddleware.ts',
  'scripts/verifyMigration010.ts',
  'scripts/verifyFixN2CompositeFkInvPurch1.ts',
  'scripts/verifyFixGrnSequence1.ts',
];

export interface BatteryItemReport {
  script: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  durationMs: number;
  exitCode: number | null;
  failureReason?: string;
}

export interface BatteryReport {
  timestamp: string;
  environment: {
    nodeEnv: string;
    hasDatabaseUrl: boolean;
    requireDb: boolean;
    isCi: boolean;
  };
  summary: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
  };
  results: BatteryItemReport[];
}

const runResults: BatteryItemReport[] = [];
let passedScripts = 0;
let failedScripts = 0;
let blockedScripts = 0;

const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
const logLines: string[] = [];

function sanitizeMessage(msg: string): string {
  return msg
    .replace(/postgresql:\/\/[^@\s]+@[^\s]+/gi, 'postgresql://[REDACTED_AUTH]@[HOST]')
    .replace(/password=[^\s]+/gi, 'password=[REDACTED]')
    .replace(/secret=[^\s]+/gi, 'secret=[REDACTED]');
}

for (const script of scripts) {
  console.log(`\n--- Running: ${script} ---`);
  const fullPath = path.resolve(process.cwd(), script);

  const startTime = Date.now();
  const result = spawnSync(tsxBin, [fullPath], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: process.env,
  });
  const durationMs = Date.now() - startTime;

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const combinedOutput = `${stdout}\n${stderr}`;

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const exitCode = result.status;
  let status: 'PASS' | 'FAIL' | 'BLOCKED' = 'FAIL';
  let failureReason: string | undefined = undefined;

  if (exitCode === 0) {
    status = 'PASS';
    passedScripts++;
  } else if (exitCode === 2) {
    status = 'BLOCKED';
    blockedScripts++;
    const match = combinedOutput.match(/\[BLOCKED\]\s*([^\r\n]+)/);
    failureReason = match ? sanitizeMessage(match[1].trim()) : 'Test prerequisites unfulfilled (BLOCKED)';
  } else {
    status = 'FAIL';
    failedScripts++;
    const match = combinedOutput.match(/\[FAIL\]\s*([^\r\n]+)/);
    failureReason = match ? sanitizeMessage(match[1].trim()) : `Script exited with non-zero code ${exitCode}`;
  }

  runResults.push({
    script,
    status,
    durationMs,
    exitCode,
    failureReason,
  });

  logLines.push(`[${status}] ${script} (${durationMs}ms, exit ${exitCode})${failureReason ? ' - ' + failureReason : ''}`);
}

const isDbRequired = process.env.REQUIRE_DB === '1' || process.env.REQUIRE_DB === 'true' || process.env.CI === 'true';

console.log('\n======================================================');
console.log('=== FOUNDATION BATTERY SUMMARY                      ===');
console.log('======================================================');
console.log('| Script                             | Status    | Time   | Exit |');
console.log('|------------------------------------|-----------|--------|------|');
for (const r of runResults) {
  const scriptName = r.script.padEnd(34, ' ');
  const statusStr = r.status.padEnd(9, ' ');
  const timeStr = `${r.durationMs}ms`.padStart(6, ' ');
  const exitStr = String(r.exitCode ?? 'ERR').padStart(4, ' ');
  console.log(`| ${scriptName} | ${statusStr} | ${timeStr} | ${exitStr} |`);
}
console.log('======================================================');
console.log(`Total Scripts: ${scripts.length} | Passed: ${passedScripts} | Failed: ${failedScripts} | Blocked: ${blockedScripts}`);

const reportData: BatteryReport = {
  timestamp: new Date().toISOString(),
  environment: {
    nodeEnv: process.env.NODE_ENV || 'development',
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== ''),
    requireDb: isDbRequired,
    isCi: process.env.CI === 'true',
  },
  summary: {
    total: scripts.length,
    passed: passedScripts,
    failed: failedScripts,
    blocked: blockedScripts,
  },
  results: runResults,
};

const testReportsDir = path.resolve(process.cwd(), '.test-reports');
if (!fs.existsSync(testReportsDir)) {
  fs.mkdirSync(testReportsDir, { recursive: true });
}

const jsonReportPath = path.join(testReportsDir, 'report.json');
fs.writeFileSync(jsonReportPath, JSON.stringify(reportData, null, 2), 'utf8');

const logReportPath = path.join(testReportsDir, 'battery.log');
const logContent = [
  '=== FOUNDATION BATTERY TEST EXECUTION LOG ===',
  `Timestamp: ${reportData.timestamp}`,
  `Total: ${scripts.length} | Passed: ${passedScripts} | Failed: ${failedScripts} | Blocked: ${blockedScripts}`,
  `Require DB: ${isDbRequired}`,
  '',
  ...logLines,
].join('\n');
fs.writeFileSync(logReportPath, logContent, 'utf8');

const summaryMdPath = path.join(testReportsDir, 'summary.md');
const summaryMdContent = [
  '# Foundation Battery Test Summary',
  `Timestamp: ${reportData.timestamp}`,
  '',
  `Total: ${scripts.length} | Passed: **${passedScripts}** | Failed: **${failedScripts}** | Blocked: **${blockedScripts}**`,
  '',
  '| Script | Status | Time | Exit |',
  '|---|---|---|---|',
  ...runResults.map((r) => `| \`${r.script}\` | **${r.status}** | ${r.durationMs}ms | ${r.exitCode} |`),
].join('\n');
fs.writeFileSync(summaryMdPath, summaryMdContent, 'utf8');

console.log(`\nArtifact reports generated in .test-reports/\n- report.json\n- battery.log\n- summary.md`);

if (failedScripts > 0) {
  console.error('\n[BATTERY ERROR] One or more test scripts FAILED.');
  process.exit(1);
}

if (isDbRequired && blockedScripts > 0) {
  console.error('\n[BATTERY ERROR] REQUIRE_DB=1 or CI=true is set, but test scripts reported BLOCKED.');
  process.exit(1);
}

if (blockedScripts > 0) {
  console.log('\n[BATTERY INFO] All tests passed or cleanly blocked due to missing local database.');
  process.exit(2);
}

process.exit(0);
