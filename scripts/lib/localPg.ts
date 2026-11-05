import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';

export interface LocalPgInstance {
  ownerUrl: string;
  appDbName: string;
  stop: () => Promise<void>;
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function findPgBin(): string | null {
  const possiblePaths = [
    '/usr/lib/postgresql/16/bin',
    '/usr/lib/postgresql/15/bin',
    '/usr/lib/postgresql/14/bin',
    '/usr/lib/postgresql/13/bin',
    '/usr/bin',
    '/usr/local/bin',
  ];

  for (const dir of possiblePaths) {
    if (fs.existsSync(path.join(dir, 'initdb')) && fs.existsSync(path.join(dir, 'pg_ctl'))) {
      return dir;
    }
  }

  try {
    const whichInit = execSync('which initdb', { encoding: 'utf8' }).trim();
    if (whichInit) {
      return path.dirname(whichInit);
    }
  } catch {}

  return null;
}

export async function startLocalPostgres(): Promise<LocalPgInstance> {
  // (a) If LOCAL_PG_OWNER_URL is provided, use it directly
  if (process.env.LOCAL_PG_OWNER_URL && process.env.LOCAL_PG_OWNER_URL.trim() !== '') {
    const ownerUrl = process.env.LOCAL_PG_OWNER_URL.trim();
    return {
      ownerUrl,
      appDbName: 'an_foundation',
      stop: async () => {},
    };
  }

  // (b) Try local binary initdb/pg_ctl
  const pgBinDir = findPgBin();
  if (!pgBinDir) {
    console.error('[localPg] NO_DB_ENVIRONMENT: PostgreSQL binaries (initdb/pg_ctl) not found in PATH or standard directories.');
    process.exit(3);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'an-pg-'));
  const dataDir = path.join(tmpDir, 'data');
  const port = await getAvailablePort();
  const dbName = 'an_foundation';

  try {
    console.log(`[localPg] Initializing ephemeral PostgreSQL cluster in ${dataDir} on port ${port}...`);
    execSync(`"${path.join(pgBinDir, 'initdb')}" -D "${dataDir}" -U an_test --auth=trust --no-locale > /dev/null 2>&1`, { stdio: 'inherit' });

    // Start server
    const logFile = path.join(tmpDir, 'postgres.log');
    const startCmd = `"${path.join(pgBinDir, 'pg_ctl')}" -D "${dataDir}" -l "${logFile}" -o "-p ${port} -h 127.0.0.1" start`;
    execSync(startCmd, { stdio: 'inherit' });

    // Wait for ready
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        execSync(`"${path.join(pgBinDir, 'pg_isready')}" -h 127.0.0.1 -p ${port} -U an_test`, { stdio: 'ignore' });
        ready = true;
        break;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
    }

    if (!ready) {
      throw new Error('PostgreSQL cluster failed to become ready within timeout');
    }

    // Create database
    execSync(`"${path.join(pgBinDir, 'createdb')}" -h 127.0.0.1 -p ${port} -U an_test ${dbName}`, { stdio: 'inherit' });

    const ownerUrl = `postgres://an_test:@127.0.0.1:${port}/${dbName}`;

    const stop = async () => {
      try {
        console.log('[localPg] Stopping ephemeral PostgreSQL cluster...');
        execSync(`"${path.join(pgBinDir, 'pg_ctl')}" -D "${dataDir}" stop -m immediate > /dev/null 2>&1`, { stdio: 'ignore' });
      } catch {}
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    };

    return {
      ownerUrl,
      appDbName: dbName,
      stop,
    };
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    console.error('[localPg] NO_DB_ENVIRONMENT: Failed to start local PostgreSQL instance:', err);
    process.exit(3);
  }
}
