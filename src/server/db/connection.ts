import fs from 'fs';
import pg from 'pg';

export function resolveSslConfig(env: Record<string, string | undefined>): pg.ConnectionConfig['ssl'] | undefined {
  const isProd = env.NODE_ENV === 'production';
  const caText = env.DATABASE_SSL_CA;
  const caFile = env.DATABASE_SSL_CA_FILE;

  if (caText && caFile) {
    throw new Error('Database SSL configuration error: Both DATABASE_SSL_CA and DATABASE_SSL_CA_FILE cannot be specified simultaneously');
  }

  let ca: Buffer | string | undefined = undefined;
  if (caText) {
    const unescaped = caText.replace(/\\n/g, '\n');
    if (!unescaped.includes('BEGIN CERTIFICATE')) {
      throw new Error('Database SSL configuration error: DATABASE_SSL_CA does not contain a valid PEM certificate');
    }
    ca = unescaped;
  } else if (caFile) {
    try {
      if (!fs.existsSync(caFile)) {
        throw new Error(`Database SSL CA file not found: ${caFile}`);
      }
      const fileContent = fs.readFileSync(caFile, 'utf8');
      if (!fileContent.includes('BEGIN CERTIFICATE')) {
        throw new Error(`Database SSL CA file does not contain a valid PEM certificate: ${caFile}`);
      }
      ca = fileContent;
    } catch (err) {
      throw new Error(`Database SSL CA file read error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (env.DATABASE_SSL === 'disable') {
    if (isProd) {
      throw new Error('Insecure database connection rejected: DATABASE_SSL=disable is strictly forbidden in production');
    }
    return undefined;
  }

  if (isProd) {
    if (env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'false') {
      throw new Error('Insecure database connection rejected: DATABASE_SSL_REJECT_UNAUTHORIZED=false is strictly forbidden in production');
    }
    return {
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
    };
  }

  // Non-production (test/development)
  if (env.DATABASE_SSL === 'require' || env.DATABASE_SSL === 'true' || env.DATABASE_SSL === 'ssl') {
    return {
      rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
      ...(ca ? { ca } : {}),
    };
  }

  if (env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'false') {
    return {
      rejectUnauthorized: false,
      ...(ca ? { ca } : {}),
    };
  }

  if (ca) {
    return { rejectUnauthorized: true, ca };
  }

  return undefined;
}

export function sanitizeConnectionString(connectionString: string): string {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error('Invalid connection string provided');
  }

  try {
    const url = new URL(connectionString);
    const paramsToRemove = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl'];
    let removed = false;
    for (const param of paramsToRemove) {
      if (url.searchParams.has(param)) {
        url.searchParams.delete(param);
        removed = true;
      }
    }
    if (removed) {
      console.warn('[db] WARNING: Ignored client-supplied SSL parameters from connection string to enforce environment policy.');
    }
    return url.toString();
  } catch (err) {
    throw new Error('Invalid database connection string format');
  }
}

export function buildPgConfig(connectionString: string, env: Record<string, string | undefined> = process.env): { connectionString: string; ssl: pg.ConnectionConfig['ssl'] } {
  const sanitized = sanitizeConnectionString(connectionString);
  const ssl = resolveSslConfig(env);
  return {
    connectionString: sanitized,
    ssl,
  };
}
