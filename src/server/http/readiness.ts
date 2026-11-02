import { Request, Response } from 'express';
import { getDefaultExecutor } from '../db/index.js';

export function handleLiveness(_req: Request, res: Response): void {
  res.status(200).json({
    status: 'ok',
    service: 'an-erp-platform',
    phase: 'HARDENED',
    time: new Date().toISOString(),
  });
}

export async function handleReadiness(_req: Request, res: Response): Promise<void> {
  const requireDb = process.env.REQUIRE_DB === '1' || process.env.REQUIRE_DB === 'true';
  const hasDbUrl = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '');

  try {
    const executor = await getDefaultExecutor();

    // Development mode without configured database
    if (!executor) {
      if (requireDb) {
        res.status(503).json({
          ready: false,
          database: 'missing_required_db',
          phase: 'HARDENED',
          message: 'REQUIRE_DB is set but no valid database executor is available',
        });
        return;
      }

      res.status(200).json({
        ready: true,
        database: 'not_configured',
        engine: null,
        phase: 'HARDENED',
      });
      return;
    }

    const healthCheck = await executor.health();

    if (healthCheck.ok) {
      res.status(200).json({
        ready: true,
        database: 'ok',
        engine: 'postgresql',
        phase: 'HARDENED',
      });
      return;
    }

    // Database is configured or required, but health check failed -> 503 Service Unavailable
    res.status(503).json({
      ready: false,
      database: 'error',
      engine: 'postgresql',
      phase: 'HARDENED',
      detail: healthCheck.detail,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = requireDb || hasDbUrl ? 503 : 200;
    res.status(statusCode).json({
      ready: false,
      database: 'error',
      engine: 'postgresql',
      phase: 'HARDENED',
      detail: message,
    });
  }
}
