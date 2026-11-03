import 'dotenv/config';
import { createApp } from './src/server/app.js';
import { defaultAuthService } from './src/server/auth/authService.js';
import { closeAllExecutors } from './src/server/db/index.js';
import { assertSafeDbRole } from './src/server/db/roleGuard.js';
import { getDefaultExecutor } from './src/server/db/index.js';

const app = createApp();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProd = process.env.NODE_ENV === 'production';

async function startServer() {
  // 1. Startup DB Role Safety Guard
  try {
    const executor = await getDefaultExecutor();
    if (executor) {
      await assertSafeDbRole(executor);
    } else if (isProd) {
      console.error('[server] FATAL: DATABASE_URL missing or unable to connect in production');
      process.exit(1);
    }
  } catch (err) {
    console.error('[server] Startup guard failure:', err);
    if (isProd) {
      process.exit(1);
    }
  }

  // 2. Initialize platform admin from environment variables
  try {
    await defaultAuthService.bootstrapPlatformAdminFromEnv();
  } catch (err) {
    console.error('[auth] Bootstrap platform admin error:', err);
    if (isProd) {
      process.exit(1);
    }
  }

  // 3. Start Express server
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[an-erp-platform] Server running on http://0.0.0.0:${PORT}`);
  });

  // Graceful shutdown handler
  const gracefulShutdown = async (signal: string) => {
    console.log(`[server] Received ${signal}, initiating graceful shutdown...`);
    server.close(async () => {
      console.log('[server] Express HTTP server closed.');
      try {
        await closeAllExecutors();
        console.log('[server] Database connections closed.');
      } catch (err) {
        console.error('[server] Error closing database connections:', err);
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('[server] Unhandled Promise Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

startServer();

export default app;
