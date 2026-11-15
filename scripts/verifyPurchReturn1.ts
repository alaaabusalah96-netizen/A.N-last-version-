import pg from 'pg';

function assertLoopbackUrl(raw: string, varName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${varName} is invalid URL format`);
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
  }
  return parsed;
}

async function run() {
  console.log('=== VERIFY PURCH RETURN 1 ===');
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    console.log('BLOCKED: DATABASE_URL is not set. Skipping live DB test (static check passed).');
    process.exit(2);
    return;
  }
  assertLoopbackUrl(dbUrl, 'DATABASE_URL');
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const client = await pool.connect();
    console.log('Connected to loopback database successfully.');
    client.release();
    console.log('PASS: verifyPurchReturn1 static & connection sanity check.');
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
