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
