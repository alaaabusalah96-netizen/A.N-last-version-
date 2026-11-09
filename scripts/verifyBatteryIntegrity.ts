import fs from 'fs';
import path from 'path';

console.log('--- Running Battery Integrity Verification (F2) ---');

const rootDir = process.cwd();
const scriptsDir = path.join(rootDir, 'scripts');
const runBatteryPath = path.join(scriptsDir, 'runFoundationBattery.ts');
const exclusionsPath = path.join(scriptsDir, 'lib/battery_exclusions.json');
const pkgPath = path.join(rootDir, 'package.json');

const runBatteryContent = fs.readFileSync(runBatteryPath, 'utf8');
const pkgContent = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const exclusions: Record<string, string> = fs.existsSync(exclusionsPath)
  ? JSON.parse(fs.readFileSync(exclusionsPath, 'utf8'))
  : {};

const verifyFiles = fs.readdirSync(scriptsDir).filter((f) => f.startsWith('verify') && f.endsWith('.ts'));

const errors: string[] = [];

for (const file of verifyFiles) {
  const isInBattery = runBatteryContent.includes(file);
  const isExcluded = Boolean(exclusions[file]);

  if (!isInBattery && !isExcluded) {
    errors.push(`[Battery Integrity] Verify script '${file}' is neither included in runFoundationBattery.ts nor listed in battery_exclusions.json.`);
  }

  // Check corresponding test script in package.json (unless excluded)
  if (!isExcluded) {
    const scriptKey = `test:${file.replace(/^verify/, '').replace(/\.ts$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
    // Also check generic or custom mapping
    const hasScript = Object.keys(pkgContent.scripts || {}).some(
      (k) => (k.startsWith('test:') || k.startsWith('verify:')) && pkgContent.scripts[k].includes(file)
    );
    if (!hasScript) {
      errors.push(`[Battery Integrity] Verify script '${file}' does not have a corresponding test:* script in package.json.`);
    }
  }
}

if (errors.length > 0) {
  console.error('[verifyBatteryIntegrity] FAILED: Battery integrity violations found:');
  errors.forEach((e) => console.error(e));
  process.exit(1);
} else {
  console.log('[verifyBatteryIntegrity] PASS: Battery integrity check passed.');
  process.exit(0);
}
