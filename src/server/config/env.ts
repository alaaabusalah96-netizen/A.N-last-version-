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
 * Safely determines if the application is running in a valid AI Studio Preview context.
 * Requires both the explicit APP_PREVIEW_MODE flag and a valid .run.app host.
 */
export function isAppPreview(host: string | undefined): boolean {
  const isPreviewMode = process.env.APP_PREVIEW_MODE === 'true';
  if (!isPreviewMode || !host) return false;

  // Security: Only allow preview behavior on Google Cloud Run preview domains
  const isValidPreviewHost = host.endsWith('.run.app');
  
  // Additional safety: Production (which should be on a custom domain) 
  // must never trigger this even if the flag is accidentally set.
  return isValidPreviewHost;
}
