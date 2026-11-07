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
    let unescaped = caText.replace(/\\n/g, '\n');
    if (!unescaped.includes('BEGIN CERTIFICATE')) {
      throw new Error('Database SSL configuration error: DATABASE_SSL_CA does not contain a valid PEM certificate');
    }
    if (!unescaped.includes('\n') && unescaped.includes('-----END CERTIFICATE-----')) {
      const match = unescaped.match(/-----BEGIN CERTIFICATE-----(.+?)-----END CERTIFICATE-----/);
      if (match) {
        const base64Body = match[1].replace(/\s+/g, '');
        unescaped = `-----BEGIN CERTIFICATE-----\n${base64Body.match(/.{1,64}/g)?.join('\n') || base64Body}\n-----END CERTIFICATE-----\n`;
      }
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
  if (!connectionString || typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new Error('Invalid connection string provided');
  }

  const str = connectionString.trim();
  const schemeMatch = str.match(/^(postgres(?:ql)?:\/\/)/i);
  if (!schemeMatch) {
    throw new Error('Invalid database connection string format');
  }
  const scheme = schemeMatch[1];
  const remainder = str.substring(scheme.length);

  const qIdx = remainder.indexOf('?');
  const mainPart = qIdx !== -1 ? remainder.substring(0, qIdx) : remainder;
  const queryPart = qIdx !== -1 ? remainder.substring(qIdx + 1) : '';

  const slashIdx = mainPart.indexOf('/');
  const authAndHost = slashIdx !== -1 ? mainPart.substring(0, slashIdx) : mainPart;
  const dbName = slashIdx !== -1 ? mainPart.substring(slashIdx + 1) : '';

  let user = '';
  let password = '';
  let hostPort = authAndHost;

  const lastAt = authAndHost.lastIndexOf('@');
  if (lastAt !== -1) {
    const userinfo = authAndHost.substring(0, lastAt);
    hostPort = authAndHost.substring(lastAt + 1);

    const firstColon = userinfo.indexOf(':');
    if (firstColon !== -1) {
      user = userinfo.substring(0, firstColon);
      password = userinfo.substring(firstColon + 1);
    } else {
      user = userinfo;
    }
  }

  if (password.startsWith('[') && password.endsWith(']')) {
    password = password.slice(1, -1);
  }

  const decUser = decodeURIComponent(user);
  const decPass = decodeURIComponent(password);

  const encUser = encodeURIComponent(decUser);
  const encPass = encodeURIComponent(decPass);

  const searchParams = new URLSearchParams(queryPart);
  const paramsToRemove = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl'];
  let removedSsl = false;
  for (const p of paramsToRemove) {
    if (searchParams.has(p)) {
      searchParams.delete(p);
      removedSsl = true;
    }
  }
  if (removedSsl) {
    console.warn('[db] WARNING: Ignored client-supplied SSL parameters from connection string to enforce environment policy.');
  }

  const cleanQuery = searchParams.toString();
  const authPart = encUser ? (encPass ? `${encUser}:${encPass}@` : `${encUser}@`) : '';
  const fullUrlStr = `${scheme}${authPart}${hostPort}/${dbName}${cleanQuery ? '?' + cleanQuery : ''}`;

  try {
    return new URL(fullUrlStr).toString();
  } catch {
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
