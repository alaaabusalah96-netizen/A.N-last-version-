import { isProduction } from '../config/env.js';

/**
 * Unified Registry of Allowed Origins for CORS and CSRF
 */

const AI_STUDIO_DEV = 'https://ais-dev-6vklnibghlun634krwmxyl-925777775579.europe-west2.run.app';
const AI_STUDIO_PRE = 'https://ais-pre-6vklnibghlun634krwmxyl-925777775579.europe-west2.run.app';

export function getAllowedOrigins(): string[] {
  const envOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  const baseOrigins = [AI_STUDIO_DEV, AI_STUDIO_PRE, ...envOrigins];

  if (!isProduction()) {
    baseOrigins.push('http://localhost:3000');
    baseOrigins.push('http://127.0.0.1:3000');
    baseOrigins.push('http://localhost:3001');
    baseOrigins.push('http://127.0.0.1:3001');
  }

  return Array.from(new Set(baseOrigins));
}

/**
 * Validates if an origin is permitted.
 * Strictly prevents wildcard reflection and spoofing.
 */
export function validateOrigin(origin: string | undefined): boolean {
  if (!origin) return false;

  const allowed = getAllowedOrigins();
  
  // Exact match only for security
  if (allowed.includes(origin)) {
    return true;
  }

  // AI Studio specific subdomains if needed (though we have explicit ones above)
  // The user requested NO wide wildcards like *.run.app, 
  // but if AI Studio URLs change dynamically, we might need a tighter regex.
  // Given the strict instruction, we stick to the explicit ones unless proven insufficient.
  
  return false;
}
