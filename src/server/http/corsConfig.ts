import cors from 'cors';
import { CorsOriginError } from './errors.js';
import { validateOrigin } from './originRegistry.js';

/**
 * Hardened CORS Configuration
 * Uses unified origin validation to prevent reflection and spoofing.
 */
export function createCorsMiddleware() {
  return cors({
    origin: (origin, callback) => {
      // Allow non-browser requests or same-origin requests (origin undefined)
      if (!origin) {
        return callback(null, true);
      }

      if (validateOrigin(origin)) {
        return callback(null, true);
      }

      return callback(new CorsOriginError(`CORS policy violation: origin '${origin}' is not permitted`));
    },
    credentials: true,
  });
}
