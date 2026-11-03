import fs from 'fs';
import path from 'path';
import { check, summary } from './lib/testkit.js';

console.log('--- Running Public Asset Inspection Verification (R8) ---');

const rootDir = process.cwd();
const targetDirs = ['public', 'dist'].map((d) => path.join(rootDir, d)).filter(fs.existsSync);

async function runTests() {
  const forbiddenExts = ['.md', '.txt', '.sql', '.ts'];
  const forbiddenKeywords = ['REPAIR', 'PHASE', 'CONSTITUTION'];

  let leakedFiles: string[] = [];

  for (const dir of targetDirs) {
    const scanDir = (currentDir: string) => {
      const items = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(currentDir, item.name);
        if (item.isDirectory()) {
          scanDir(fullPath);
        } else if (item.isFile()) {
          const ext = path.extname(item.name).toLowerCase();
          const upperName = item.name.toUpperCase();

          const hasForbiddenExt = forbiddenExts.includes(ext);
          const hasForbiddenKeyword = forbiddenKeywords.some((kw) => upperName.includes(kw));

          if (hasForbiddenExt || hasForbiddenKeyword) {
            leakedFiles.push(path.relative(rootDir, fullPath));
          }
        }
      }
    };

    scanDir(dir);
  }

  await check(
    'No sensitive text, sql, script or instruction files present in public or dist assets',
    leakedFiles.length === 0,
    leakedFiles.length > 0 ? `Leaked files detected: ${leakedFiles.join(', ')}` : undefined
  );

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
