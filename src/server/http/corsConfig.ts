import cors from 'cors';
import { CorsOriginError } from './errors.js';
import { validateOrigin } from './originRegistry.js';

/**
 * Exact-origin CORS middleware.
 *
 * Requests without Origin are allowed to continue because
 * CORS is a browser cross-origin policy, not authentication.
 *
 * Requests with an untrusted Origin are rejected server-side.
 */
export function createCorsMiddleware() {
  return cors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }

      if (validateOrigin(origin)) {
        return callback(null, true);
      }

      return callback(
        new CorsOriginError(
          'CORS policy violation: origin is not permitted'
        )
      );
    },
    credentials: true,
    optionsSuccessStatus: 204,
  });
}
