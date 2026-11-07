import helmet from 'helmet';
import { Application } from 'express';

/**
 * Applies security headers (Helmet) with minimal safe Content Security Policy.
 */
export function applySecurityMiddleware(app: Application): void {
  const isProd = process.env.NODE_ENV === 'production';

  // Respect TRUST_PROXY environment variable
  if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  // Production-grade minimal Content Security Policy
  app.use(
    helmet({
      contentSecurityPolicy: isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'https:'],
              connectSrc: ["'self'", 'https://*.google.com', 'https://*.run.app'],
              objectSrc: ["'none'"],
              baseUri: ["'self'"],
              formAction: ["'self'"],
              frameAncestors: ["'self'", 'https://aistudio.google.com', 'https://*.google.com'],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
      frameguard: false, // Allow framing in AI Studio
    })
  );
}
