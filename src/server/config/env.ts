import fs from 'fs';
import path from 'path';

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function isStrictEnv(): boolean {
  return process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test';
}

export function assertValidNodeEnv(): void {
  const env = process.env.NODE_ENV;
  if (!env || !['development', 'test', 'production'].includes(env)) {
    throw new Error(`[env] FATAL: Invalid or missing NODE_ENV='${env}'. Allowed values: development, test, production.`);
  }
}

/**
 * Trusted Google Cloud Run preview domains for AI Studio.
 */
export const TRUSTED_PREVIEW_HOSTS = [
  'ais-dev-6vklnibghlun634krwmxyl-925777775579.europe-west2.run.app',
  'ais-pre-6vklnibghlun634krwmxyl-925777775579.europe-west2.run.app',
];

/**
 * Safely determines if the application is running in a valid AI Studio Preview context.
 * Requires:
 * 1. APP_PREVIEW_MODE === 'true'
 * 2. NODE_ENV !== 'production'
 * 3. Host matches an explicit trusted preview domain (or localhost during preview mode).
 */
export function isAppPreview(host: string | undefined): boolean {
  const isPreviewFlag = process.env.APP_PREVIEW_MODE === 'true';
  const isProd = process.env.NODE_ENV === 'production';

  if (!isPreviewFlag || !host || isProd) {
    return false;
  }

  // Strip port if present (e.g. host:3000 or host:443)
  const cleanHost = host.split(':')[0].trim().toLowerCase();

  // Allow trusted preview hosts, or local internal loopback during dev preview mode
  return TRUSTED_PREVIEW_HOSTS.includes(cleanHost) || cleanHost === '127.0.0.1' || cleanHost === 'localhost';
}
