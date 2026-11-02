import cors from 'cors';

/**
 * Hardened CORS Configuration
 * Prevents wildcard origin reflection when credentials (cookies) are transmitted.
 */
export function createCorsMiddleware() {
  const isProd = process.env.NODE_ENV === 'production';
  const allowedOriginsEnv = process.env.CORS_ORIGINS;
  const configuredOrigins = allowedOriginsEnv
    ? allowedOriginsEnv.split(',').map((o) => o.trim())
    : [];

  return cors({
    origin: (origin, callback) => {
      // Allow non-browser requests or same-origin requests (origin undefined)
      if (!origin) {
        return callback(null, true);
      }

      // In production, strictly match configured origins
      if (isProd) {
        if (configuredOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`CORS blocked for origin: ${origin}`));
      }

      // In development: allow configured origins, or localhost, or dev domains
      if (
        configuredOrigins.length === 0 ||
        configuredOrigins.includes(origin) ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1') ||
        origin.includes('.run.app')
      ) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked in dev for origin: ${origin}`));
    },
    credentials: true,
  });
}
