import fs from 'fs';
import path from 'path';
import { Request, Response } from 'express';
import { getDefaultExecutor } from '../db/index.js';
import { assertSafeDbRole } from '../db/roleGuard.js';

export function handleLiveness(_req: Request, res: Response): void {
  res.status(200).json({ status: 'ok', service: 'an-erp-platform' });
}

export async function handleReadiness(_req: Request, res: Response): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    res.status(503).json({ ready: false, reason: 'DATABASE_URL not configured' });
    return;
  }

  try {
    const executor = await getDefaultExecutor();
    if (!executor) {
      res.status(503).json({ ready: false, reason: 'Database connection unavailable' });
      return;
    }

    // 1. Database Health
    const health = await executor.health();
    if (!health.ok) {
      res.status(503).json({ ready: false, reason: 'Database health check failed' });
      return;
    }

    // 2. Role Guard
    await assertSafeDbRole(executor);

    // 3. Complete Schema Migrations Verification
    const migrationsDir = path.resolve(process.cwd(), 'database/migrations');
    if (fs.existsSync(migrationsDir)) {
      const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
      const migRes = await executor.query<{ version: string }>('SELECT version FROM schema_migrations;');
      const appliedSet = new Set(migRes.rows.map((r) => r.version));

      // Check for any on-disk migrations not yet applied
      const pendingFiles = sqlFiles.filter((f) => !appliedSet.has(f));
      if (pendingFiles.length > 0) {
        console.warn(`[readiness] Pending migrations detected: ${pendingFiles.join(', ')}`);
        res.status(503).json({ ready: false, database: 'migrations_pending' });
        return;
      }

      // Check for any applied migrations missing from disk
      const diskSet = new Set(sqlFiles);
      const orphanApplied = Array.from(appliedSet).filter((v) => !diskSet.has(v));
      if (orphanApplied.length > 0) {
        console.warn(`[readiness] Unrecognized migrations in database: ${orphanApplied.join(', ')}`);
        res.status(503).json({ ready: false, database: 'migrations_mismatch' });
        return;
      }
    }

    res.status(200).json({
      ready: true,
      version: process.env.APP_VERSION || '1.0.0',
    });
  } catch (err) {
    console.error('[readiness] Readiness probe failed:', err);
    res.status(503).json({ ready: false, reason: 'Readiness check failed' });
  }
}
