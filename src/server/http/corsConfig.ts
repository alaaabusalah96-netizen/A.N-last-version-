import cors from 'cors';
import { CorsOriginError } from './errors.js';

/**
 * Hardened CORS Configuration
 * Strictly prevents wildcard origin reflection and domain prefix spoofing (e.g. evil-localhost.com).
 */
export function createCorsMiddleware() {
  const isProd = process.env.NODE_ENV === 'production';
  const allowedOriginsEnv = process.env.CORS_ORIGINS;
  const configuredOrigins = allowedOriginsEnv
    ? allowedOriginsEnv
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : [];

  if (isProd && configuredOrigins.length === 0) {
    throw new Error('CORS_ORIGINS is strictly required and cannot be empty in production mode');
  }

  const localOriginRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  return cors({
    origin: (origin, callback) => {
      // Allow non-browser requests or same-origin requests (origin undefined)
      if (!origin) {
        return callback(null, true);
      }

      // Check explicit configured origins first (exact match)
      if (configuredOrigins.includes(origin)) {
        return callback(null, true);
      }

      // In production: reject any origin not explicitly present in CORS_ORIGINS
      if (isProd) {
        return callback(new CorsOriginError(`CORS policy violation: origin '${origin}' is not allowed`));
      }

      // In development: strictly allow exact localhost / 127.0.0.1 origins
      if (localOriginRegex.test(origin)) {
        return callback(null, true);
      }

      return callback(new CorsOriginError(`CORS policy violation in dev: origin '${origin}' is not permitted`));
    },
    credentials: true,
  });
}
