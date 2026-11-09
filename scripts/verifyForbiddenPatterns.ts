import fs from 'fs';
import path from 'path';

console.log('--- Running Forbidden Patterns Verification (F2) ---');

interface AllowlistEntry {
  path: string;
  pattern: string;
  reason: string;
}

const rootDir = process.cwd();
const allowlistPath = path.join(rootDir, 'database/forbidden_patterns_allowlist.json');
let allowlist: AllowlistEntry[] = [];
if (fs.existsSync(allowlistPath)) {
  try {
    allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  } catch {}
}

function isAllowed(filePath: string, patternName: string): boolean {
  const relPath = path.relative(rootDir, filePath);
  return allowlist.some((item) => item.path === relPath && item.pattern === patternName);
}

const errors: string[] = [];

function scanFile(filePath: string) {
  const content = fs.readFileSync(filePath, 'utf8');

  // 1. Empty swallowed catch
  const emptyCatchRegex = /catch\s*(\([^)]*\))?\s*\{\s*\}/g;
  if (emptyCatchRegex.test(content) && !isAllowed(filePath, 'empty_catch')) {
    errors.find((e) => e.includes(filePath)) || errors.push(`[Forbidden Pattern] Empty swallowed catch found in ${filePath}`);
  }

  // 2. Dollar-quoted EXECUTE
  const executeDollarRegex = /EXECUTE\s+\$\w+\$/i;
  if (executeDollarRegex.test(content) && !isAllowed(filePath, 'dollar_execute')) {
    errors.push(`[Forbidden Pattern] Dollar-quoted EXECUTE found in ${filePath}`);
  }

  // 3. PASSWORD $d
  const passwordBindRegex = /PASSWORD\s+\$\d/i;
  if (passwordBindRegex.test(content) && !isAllowed(filePath, 'password_bind')) {
    errors.push(`[Forbidden Pattern] PASSWORD bound via parameter found in ${filePath}`);
  }

  // 4. ON DATABASE current_database()
  const currentDbRevokeRegex = /ON\s+DATABASE\s+current_database/i;
  if (currentDbRevokeRegex.test(content) && !isAllowed(filePath, 'current_database_revoke')) {
    errors.push(`[Forbidden Pattern] ON DATABASE current_database found in ${filePath}`);
  }

  // 5. rejectUnauthorized: false outside connection.ts
  if (!filePath.endsWith('connection.ts')) {
    const rejectUnauthRegex = /rejectUnauthorized\s*:\s*false/;
    if (rejectUnauthRegex.test(content) && !isAllowed(filePath, 'reject_unauthorized_false')) {
      errors.push(`[Forbidden Pattern] rejectUnauthorized: false found outside connection.ts in ${filePath}`);
    }
  }
}

function walkDir(dir: string) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '.git') {
        walkDir(fullPath);
      }
    } else if (entry.isFile() && (fullPath.endsWith('.ts') || fullPath.endsWith('.js'))) {
      if (
        fullPath.includes('/src/server/') ||
        fullPath.includes('/scripts/provision') ||
        fullPath.includes('/scripts/migrate')
      ) {
        scanFile(fullPath);
      }
    }
  }
}

walkDir(path.join(rootDir, 'src/server'));
walkDir(path.join(rootDir, 'scripts'));

if (errors.length > 0) {
  console.error('[verifyForbiddenPatterns] FAILED: Forbidden code patterns detected:');
  errors.forEach((e) => console.error(e));
  process.exit(1);
} else {
  console.log('[verifyForbiddenPatterns] PASS: No forbidden code patterns detected.');
  process.exit(0);
}
