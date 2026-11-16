import { redactLogText } from './backupUtils.js';

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

export async function checkOpsEndpoints(baseUrl: string, includeReady: boolean): Promise<void> {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const healthRes = await fetch(`${normalizedBase}/api/health`);
  const healthBody = (await healthRes.json().catch(() => ({}))) as Record<string, unknown>;

  if (healthRes.status !== 200 || healthBody.status !== 'ok') {
    throw new Error(`/api/health check failed: HTTP ${healthRes.status}`);
  }
  console.log(`[healthCheck] /api/health OK (service=${String(healthBody.service || 'unknown')})`);

  if (includeReady) {
    const readyRes = await fetch(`${normalizedBase}/api/ready`);
    const readyBody = (await readyRes.json().catch(() => ({}))) as Record<string, unknown>;
    if (readyRes.status !== 200 || readyBody.ready !== true) {
      throw new Error(`/api/ready check failed: HTTP ${readyRes.status} (${String(readyBody.reason || readyBody.database || 'not ready')})`);
    }
    console.log(`[healthCheck] /api/ready OK (version=${String(readyBody.version || 'unknown')})`);
  }
}

const isDirectCli = process.argv[1]?.endsWith('healthCheck.ts');
if (isDirectCli) {
  const args = process.argv.slice(2);
  const baseUrl = getArgValue(args, '--base-url') || process.env.HEALTH_BASE_URL || 'http://127.0.0.1:3000';
  const includeReady = !args.includes('--liveness-only');

  checkOpsEndpoints(baseUrl, includeReady).catch((err) => {
    console.error('[healthCheck] FAILED:', redactLogText(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
