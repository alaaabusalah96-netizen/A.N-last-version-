import 'dotenv/config';
import { defaultAuthService } from '../src/server/auth/authService.js';
import { closeAllExecutors } from '../src/server/db/index.js';
import { assertValidNodeEnv } from '../src/server/config/env.js';

function redactSecrets(message: string): string {
  return message
    .replace(/postgresql:\/\/[^@\s]+@[^\s]+/gi, 'postgresql://[REDACTED]@[HOST]')
    .replace(/postgres:\/\/[^@\s]+@[^\s]+/gi, 'postgres://[REDACTED]@[HOST]')
    .replace(/password\s*[:=]\s*[^\s,;]+/gi, 'password=[REDACTED]')
    .replace(/\$argon2[a-z0-9$=,+/-]+/gi, '[REDACTED_HASH]');
}

async function main(): Promise<void> {
  assertValidNodeEnv();
  console.log('--- Running Explicit Initial Platform Admin Bootstrap ---');

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    console.error('[bootstrap:admin] ERROR: DATABASE_URL is required (must connect using the provisioned an_app role).');
    process.exit(1);
  }

  try {
    const result = await defaultAuthService.createInitialPlatformAdminFromEnv();
    if (result.status === 'created') {
      console.log(`[bootstrap:admin] SUCCESS: Created initial platform_admin '${result.username}' (id=${result.userId}).`);
    } else {
      console.log(`[bootstrap:admin] OK: platform_admin '${result.username}' already exists (id=${result.userId}). No changes made.`);
    }
    process.exitCode = 0;
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    console.error(`[bootstrap:admin] FAILED: ${redactSecrets(rawMsg)}`);
    process.exitCode = 1;
  } finally {
    await closeAllExecutors();
  }
}

main();
