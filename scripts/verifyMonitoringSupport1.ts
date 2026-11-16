import fs from 'fs';
import path from 'path';
import { handleLiveness } from '../src/server/http/readiness.js';
import { errorHandler } from '../src/server/http/errorHandler.js';

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
  console.log('=== VERIFY AN-OPS-MONITORING-SUPPORT-1 (Health, Redaction & Support Docs) ===');
  const rootDir = process.cwd();

  const supportPath = path.join(rootDir, 'docs/ops/SUPPORT.md');
  check('M1', fs.existsSync(supportPath), 'docs/ops/SUPPORT.md exists');

  const supportDoc = fs.existsSync(supportPath) ? fs.readFileSync(supportPath, 'utf8') : '';
  check(
    'M2',
    supportDoc.includes('/api/health') && supportDoc.includes('/api/ready') && supportDoc.includes('X-Request-Id'),
    'SUPPORT.md covers /api/health, /api/ready, and X-Request-Id incident tracing'
  );

  check('M3', fs.existsSync(path.join(rootDir, 'scripts/ops/healthCheck.ts')), 'scripts/ops/healthCheck.ts exists');

  const envExample = fs.readFileSync(path.join(rootDir, '.env.example'), 'utf8');
  check('M4', envExample.includes('LOG_LEVEL='), '.env.example defines LOG_LEVEL');

  // Behavioral check: liveness response contains status=ok, service, version, uptimeSeconds, timestamp
  let livenessStatus = 0;
  let livenessBody: Record<string, unknown> = {};
  handleLiveness(
    {} as any,
    {
      status(code: number) {
        livenessStatus = code;
        return this;
      },
      json(payload: Record<string, unknown>) {
        livenessBody = payload;
        return this;
      },
    } as any
  );

  check(
    'M5',
    livenessStatus === 200 &&
      livenessBody.status === 'ok' &&
      livenessBody.service === 'an-erp-platform' &&
      typeof livenessBody.uptimeSeconds === 'number' &&
      typeof livenessBody.timestamp === 'string',
    'handleLiveness returns 200 with ok status, version, uptimeSeconds, and timestamp'
  );

  // Behavioral check: errorHandler redacts PG URLs/passwords in server logs and never leaks them to client
  const loggedLines: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedLines.push(args.map((a) => String(a)).join(' '));
  };
  let errStatus = 0;
  let errBody: Record<string, unknown> = {};
  try {
    errorHandler(
      new Error('Connection failed for postgresql://an_app:TopSecretPassword99@127.0.0.1:5432/an_foundation password=AnotherSecret!'),
      { requestId: 'req-trace-1234', method: 'GET', path: '/api/companies' } as any,
      {
        headersSent: false,
        status(code: number) {
          errStatus = code;
          return this;
        },
        json(payload: Record<string, unknown>) {
          errBody = payload;
          return this;
        },
      } as any,
      (() => {}) as any
    );
  } finally {
    console.error = origConsoleError;
  }

  const logOutput = loggedLines.join('\n');
  check(
    'M6',
    logOutput.includes('req-trace-1234') &&
      !logOutput.includes('TopSecretPassword99') &&
      !logOutput.includes('AnotherSecret!'),
    'errorHandler logs X-Request-Id while redacting DB URLs and passwords'
  );
  check(
    'M7',
    errStatus === 500 && errBody.requestId === 'req-trace-1234' && !JSON.stringify(errBody).includes('TopSecretPassword99'),
    'errorHandler returns sanitized 500 response with requestId'
  );

  console.log(`\nSummary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run();
