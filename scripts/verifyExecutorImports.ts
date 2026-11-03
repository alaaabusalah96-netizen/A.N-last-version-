import fs from 'fs';
import path from 'path';
import { check, summary } from './lib/testkit.js';

console.log('--- Running Architectural Guard: getDefaultExecutor Imports (R9.3) ---');

const rootDir = process.cwd();

interface AllowlistItem {
  file: string;
  reason: string;
}

async function runTests() {
  const allowlistPath = path.join(rootDir, 'database/executor_import_allowlist.json');
  await check('database/executor_import_allowlist.json exists', fs.existsSync(allowlistPath));

  const allowlist: AllowlistItem[] = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  const allowedFiles = new Set(allowlist.map((item) => item.file));

  const serverDir = path.join(rootDir, 'src/server');
  const unauthorizedFiles: string[] = [];

  const scanDir = (currentDir: string) => {
    const items = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(currentDir, item.name);
      if (item.isDirectory()) {
        scanDir(fullPath);
      } else if (item.isFile() && (item.name.endsWith('.ts') || item.name.endsWith('.js'))) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

        // Check if file imports getDefaultExecutor
        const importsGetDefaultExecutor = /import\s+.*getDefaultExecutor.*/.test(content);

        if (importsGetDefaultExecutor && !allowedFiles.has(relPath)) {
          unauthorizedFiles.push(relPath);
        }
      }
    }
  };

  if (fs.existsSync(serverDir)) {
    scanDir(serverDir);
  }

  await check(
    'No unauthorized files under src/server import getDefaultExecutor directly',
    unauthorizedFiles.length === 0,
    unauthorizedFiles.length > 0 ? `Unauthorized files importing getDefaultExecutor: ${unauthorizedFiles.join(', ')}` : undefined
  );

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
