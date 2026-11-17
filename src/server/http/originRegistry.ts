import { isProduction, TRUSTED_PREVIEW_HOSTS } from '../config/env.js';

/**
 * Exact Origin Registry.
 *
 * Production and non-production origins are deliberately
 * separated. No wildcard subdomain matching is permitted.
 */

const PRODUCTION_ORIGIN =
  'https://erp-platform-foundation.ai.studio';

function parseConfiguredOrigins(): string[] {
  return (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function normalizeExactOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);

    if (
      parsed.protocol !== 'https:' &&
      parsed.protocol !== 'http:'
    ) {
      return null;
    }

    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }

    return parsed.origin;
  } catch {
    return null;
  }
}

export function getAllowedOrigins(): string[] {
  const configuredOrigins = parseConfiguredOrigins()
    .map(normalizeExactOrigin)
    .filter((origin): origin is string => origin !== null);

  if (isProduction()) {
    return Array.from(
      new Set([
        PRODUCTION_ORIGIN,
        ...configuredOrigins,
      ])
    );
  }

  const previewOrigins = TRUSTED_PREVIEW_HOSTS.map(
    (host) => `https://${host}`
  );

  const developmentOrigins =
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'test'
      ? [
          'http://localhost:3000',
          'http://127.0.0.1:3000',
          'http://localhost:3001',
          'http://127.0.0.1:3001',
        ]
      : [];

  return Array.from(
    new Set([
      ...previewOrigins,
      ...configuredOrigins,
      ...developmentOrigins,
    ])
  );
}

/**
 * Exact string comparison only.
 *
 * No wildcard, regex suffix matching, subdomain matching,
 * or implicit AI Studio domain trust.
 */
export function validateOrigin(
  origin: string | undefined,
  additionalOrigins: string[] = []
): boolean {
  if (!origin || origin === 'null') {
    return false;
  }

  const normalized = normalizeExactOrigin(origin);

  if (!normalized || normalized !== origin) {
    return false;
  }

  const allowed = new Set([
    ...getAllowedOrigins(),
    ...additionalOrigins
      .map(normalizeExactOrigin)
      .filter((value): value is string => value !== null),
  ]);

  return allowed.has(normalized);
}
