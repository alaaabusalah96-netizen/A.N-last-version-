import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { Server } from 'http';
import express from 'express';
import { check, blocked, summary } from './lib/testkit.js';
import { createApp } from '../src/server/app.js';
import { requestIdMiddleware, errorHandler } from '../src/server/http/errorHandler.js';
import { closeAllExecutors } from '../src/server/db/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEAD_DB_SECRET = 'DeadDbPass7788';
const DEAD_DB_URL = `postgresql://an_app:${DEAD_DB_SECRET}@127.0.0.1:1/an_foundation`;

function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function readAlerts(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Child mode: real app with an unreachable DB. Prints one RESULT line for the parent.
async function runDeadDbChild() {
  const { server, base } = await listen(createApp());
  const ready = await fetch(`${base}/api/ready`, { headers: { 'X-Request-Id': 'child-ready-0001' } });
  const readyBody = await ready.text();
  const health = await fetch(`${base}/api/health`);
  const healthBody = await health.json();
  console.log(
    'RESULT:' +
      JSON.stringify({
        readyStatus: ready.status,
        readyBody,
        readyRequestId: ready.headers.get('x-request-id'),
        healthStatus: health.status,
        healthOk: healthBody.status === 'ok',
      })
  );
  server.close();
  process.exit(0);
}

async function run() {
  console.log('=== VERIFY AN-OPS-MONITORING-LIVE-1 (live health/readiness, request IDs, redaction, local alerts) ===');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'an-monitoring-live-'));
  const alertFile = path.join(tmpDir, 'alerts.jsonl');

  // L1-L3: live DB up (needs DATABASE_URL, same as other live suites)
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    blocked('DATABASE_URL not set: live readiness-with-DB-up checks (L1-L3) cannot run');
  } else {
    const { server, base } = await listen(createApp());
    try {
      const health = await fetch(`${base}/api/health`);
      const healthBody = await health.json();
      await check(
        'L1: GET /api/health returns 200 ok with uptime and X-Request-Id',
        health.status === 200 && healthBody.status === 'ok' && !!health.headers.get('x-request-id')
      );

      const ready = await fetch(`${base}/api/ready`);
      const readyBody = await ready.json();
      await check('L2: GET /api/ready returns 200 ready=true with DB up and migrations applied', ready.status === 200 && readyBody.ready === true, `status=${ready.status}`);

      const echoed = await fetch(`${base}/api/health`, { headers: { 'X-Request-Id': 'trace-ABC12345' } });
      const bad = await fetch(`${base}/api/health`, { headers: { 'X-Request-Id': 'bad id!<script>' } });
      const none = await fetch(`${base}/api/health`);
      await check(
        'L3: valid X-Request-Id is echoed; invalid or missing one is replaced by a UUID',
        echoed.headers.get('x-request-id') === 'trace-ABC12345' &&
          UUID_RE.test(bad.headers.get('x-request-id') || '') &&
          UUID_RE.test(none.headers.get('x-request-id') || '')
      );
    } finally {
      server.close();
      await closeAllExecutors().catch(() => undefined);
    }
  }

  // L4-L6: real middleware chain, known error, redaction and local alert sink
  const prevAlertEnv = process.env.OPS_ALERT_LOG_FILE;
  process.env.OPS_ALERT_LOG_FILE = alertFile;
  const logged: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(' '));
  };
  const probe = express();
  probe.use(requestIdMiddleware);
  probe.get('/boom', () => {
    throw new Error('connect failed postgresql://an_app:LiveSecretPw4455@127.0.0.1:5432/an_foundation password=LiveSecretPw4455 Bearer abcdef1234567890token');
  });
  probe.get('/dbdown', () => {
    throw new Error('DB_UNAVAILABLE: could not connect with password=LiveSecretPw4455');
  });
  probe.use(errorHandler);
  const { server: probeServer, base: probeBase } = await listen(probe);
  let boomRes: Response | undefined;
  let boomText = '';
  let dbDownRes: Response | undefined;
  try {
    boomRes = await fetch(`${probeBase}/boom`, { headers: { 'X-Request-Id': 'known-error-0001' } });
    boomText = await boomRes.text();
    dbDownRes = await fetch(`${probeBase}/dbdown`, { headers: { 'X-Request-Id': 'known-dbdown-0002' } });
    await dbDownRes.text();
  } finally {
    probeServer.close();
    console.error = origErr;
  }
  const logText = logged.join('\n');
  const alertRaw = fs.existsSync(alertFile) ? fs.readFileSync(alertFile, 'utf8') : '';
  const alerts = readAlerts(alertFile);

  await check(
    'L4: known 500 over real HTTP returns sanitized body with the same requestId',
    boomRes?.status === 500 &&
      boomRes.headers.get('x-request-id') === 'known-error-0001' &&
      boomText.includes('known-error-0001') &&
      !boomText.includes('LiveSecretPw4455')
  );
  await check(
    'L5: server log has the requestId and no secret, DB URL password or bearer token',
    logText.includes('known-error-0001') &&
      !logText.includes('LiveSecretPw4455') &&
      !logText.includes('abcdef1234567890token')
  );
  await check(
    'L6: local alert file gets internal_error and db_unavailable lines with requestIds and no secrets',
    alerts.some((a) => a.event === 'internal_error' && a.requestId === 'known-error-0001' && a.severity === 'critical') &&
      alerts.some((a) => a.event === 'db_unavailable' && a.requestId === 'known-dbdown-0002') &&
      dbDownRes?.status === 503 &&
      !alertRaw.includes('LiveSecretPw4455') &&
      !alertRaw.includes('abcdef1234567890token')
  );

  // L7: sink is off when OPS_ALERT_LOG_FILE is unset
  delete process.env.OPS_ALERT_LOG_FILE;
  const offFile = path.join(tmpDir, 'must-not-exist.jsonl');
  const silentErr = console.error;
  console.error = () => undefined;
  try {
    errorHandler(new Error('boom'), { requestId: 'off-0001', method: 'GET', path: '/x' } as any, { headersSent: false, status() { return this; }, json() { return this; } } as any, (() => undefined) as any);
  } finally {
    console.error = silentErr;
  }
  await check('L7: no alert file is written when OPS_ALERT_LOG_FILE is unset (sink is opt-in, local only)', !fs.existsSync(offFile) && readAlerts(alertFile).length === alerts.length);
  if (prevAlertEnv !== undefined) process.env.OPS_ALERT_LOG_FILE = prevAlertEnv;

  // L8-L10: DB down, real app in a child process
  const deadAlertFile = path.join(tmpDir, 'dead-alerts.jsonl');
  const child = spawnSync('npx', ['tsx', 'scripts/verifyMonitoringLive1.ts', '--child-dead-db'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, DATABASE_URL: DEAD_DB_URL, OPS_ALERT_LOG_FILE: deadAlertFile, NODE_ENV: 'test' },
  });
  const resultLine = (child.stdout || '').split('\n').find((l) => l.startsWith('RESULT:'));
  const result = resultLine ? JSON.parse(resultLine.slice('RESULT:'.length)) : null;
  const childLogs = `${child.stdout || ''}\n${child.stderr || ''}`;
  const deadAlerts = readAlerts(deadAlertFile);

  await check(
    'L8: with the DB unreachable /api/ready returns 503 ready=false and /api/health stays 200',
    !!result && result.readyStatus === 503 && JSON.parse(result.readyBody).ready === false && result.healthStatus === 200 && result.healthOk === true,
    result ? `ready=${result.readyStatus} health=${result.healthStatus}` : `child failed: ${(child.stderr || '').slice(0, 200)}`
  );
  await check(
    'L9: DB-down response and child logs leak neither the DB password nor the DB host:port',
    !!result &&
      !result.readyBody.includes(DEAD_DB_SECRET) &&
      !result.readyBody.includes('127.0.0.1:1') &&
      !childLogs.includes(DEAD_DB_SECRET) &&
      result.readyRequestId === 'child-ready-0001'
  );
  await check(
    'L10: DB-down readiness failure writes a critical readiness_failed alert with the requestId and no secret',
    deadAlerts.some((a) => a.event === 'readiness_failed' && a.severity === 'critical' && a.requestId === 'child-ready-0001') &&
      !(fs.existsSync(deadAlertFile) ? fs.readFileSync(deadAlertFile, 'utf8') : '').includes(DEAD_DB_SECRET)
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
  const s = summary();
  process.exit(s.exitCode);
}

if (process.argv.includes('--child-dead-db')) {
  runDeadDbChild().catch((e) => {
    console.error('child failed', e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
} else {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
