import { isProduction, TRUSTED_PREVIEW_HOSTS } from '../config/env.js';

/**
 * Unified Registry of Allowed Origins for CORS and CSRF
 */

export function getAllowedOrigins(): string[] {
  const envOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  const previewOrigins = TRUSTED_PREVIEW_HOSTS.map(host => `https://${host}`);
  const defaultOrigins = [
    ...previewOrigins,
    'https://aistudio.google.com',
    'https://erp-platform-foundation.ai.studio',
  ];
  const baseOrigins = [...defaultOrigins, ...envOrigins];

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
export function validateOrigin(origin: string | undefined, additionalOrigins: string[] = []): boolean {
  if (!origin) return false;

  const allowed = getAllowedOrigins();
  const allAllowed = new Set([...allowed, ...additionalOrigins]);
  
  // Exact match only for security
  if (allAllowed.has(origin)) {
    return true;
  }

  // Allow Google AI Studio platform and valid AI Studio app domains
  if (origin === 'https://aistudio.google.com' || /^https:\/\/[a-z0-9-]+\.ai\.studio$/.test(origin)) {
    return true;
  }
  
  return false;
}
