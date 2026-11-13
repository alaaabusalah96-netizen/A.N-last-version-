import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;

function assertCheck(id: string, description: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`[PASS] ${id}: ${description}`);
    passed++;
  } else {
    console.error(`[FAIL] ${id}: ${description}${detail ? ` (${detail})` : ''}`);
    failed++;
  }
}

function readRel(relPath: string): string {
  const full = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required file: ${relPath}`);
  }
  return fs.readFileSync(full, 'utf8');
}

function run() {
  console.log('=== Running verifyDocsConsistency1 (AN-FIX-DOCS-SCOPE-15) ===\n');

  // D1: No occurrence of hybrid as an approved option in strategy/ADR/P02a docs
  const strategyFiles = [
    'docs/foundation/DATABASE_STRATEGY.md',
    'docs/foundation/ARCHITECTURE_DECISIONS.md',
    'docs/foundation/P02a_RESULTS.md',
  ];
  const d1Violations: string[] = [];
  for (const rel of strategyFiles) {
    const content = readRel(rel);
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (/hybrid/i.test(line)) {
        const hasRejectionContext =
          line.includes('مرفوض') ||
          line.includes('رُفض') ||
          /not supported/i.test(line);
        if (!hasRejectionContext) {
          d1Violations.push(`${rel}:${idx + 1}: "${line.trim()}"`);
        }
      }
    });
  }
  const dbStrategy = readRel('docs/foundation/DATABASE_STRATEGY.md');
  const archDecisions = readRel('docs/foundation/ARCHITECTURE_DECISIONS.md');
  const hasThreeModesAndGuards =
    dbStrategy.includes('central') &&
    dbStrategy.includes('per_company') &&
    dbStrategy.includes('on_prem') &&
    dbStrategy.includes('TENANT_DB_ROUTE_MISSING') &&
    dbStrategy.includes('DDL') &&
    dbStrategy.includes('Provisioner') &&
    archDecisions.includes('central') &&
    archDecisions.includes('per_company') &&
    archDecisions.includes('on_prem');

  assertCheck(
    'D1',
    'Strategy/ADR/P02a docs reject hybrid architecturally (zero unrejected hybrid references) & document 3 modes + DDL/Provisioner/Fail-Closed guards',
    d1Violations.length === 0 && hasThreeModesAndGuards,
    d1Violations.length > 0 ? d1Violations.join('; ') : undefined
  );

  // D2: TenantDatabaseResolver rejects hybrid statically and types exclude hybrid
  const resolverSrc = readRel('src/server/db/TenantDatabaseResolver.ts');
  const dbTypesSrc = readRel('src/server/db/types.ts');
  const d2Pass =
    resolverSrc.includes("envMode === 'hybrid'") &&
    resolverSrc.includes('DB_MODE_INVALID') &&
    resolverSrc.includes('not supported') &&
    dbTypesSrc.includes("'central'") &&
    dbTypesSrc.includes("'per_company'") &&
    dbTypesSrc.includes("'on_prem'") &&
    !dbTypesSrc.includes("'hybrid'");

  assertCheck(
    'D2',
    'TenantDatabaseResolver.ts explicitly rejects hybrid and db/types.ts defines only central | per_company | on_prem',
    d2Pass
  );

  // D3: MVP_SCOPE.md mentions المبيعات and الخزينة ONLY with explicit OPEN_GAPS cross-reference
  const mvpScope = readRel('docs/foundation/MVP_SCOPE.md');
  const mvpLines = mvpScope.split(/\r?\n/);
  const treasuryLine = mvpLines.find((l) => l.startsWith('###') && l.includes('الخزينة'));
  const salesLine = mvpLines.find((l) => l.startsWith('###') && l.includes('المبيعات'));
  const d3Pass = Boolean(
    treasuryLine &&
      treasuryLine.includes('غير منفذة حتى تاريخه') &&
      treasuryLine.includes('OPEN_GAPS.md') &&
      salesLine &&
      salesLine.includes('غير منفذة حتى تاريخه') &&
      salesLine.includes('OPEN_GAPS.md')
  );

  assertCheck(
    'D3',
    'MVP_SCOPE.md includes explicit OPEN_GAPS.md cross-reference next to both الخزينة and المبيعات',
    d3Pass
  );

  // D4: Custom fields scope doc states item only and remaining schema entities are non-implemented
  const waveAChanges = readRel('WAVE-A-CHANGES.md');
  const customFieldServiceSrc = readRel('src/server/customization/customFieldService.ts');
  const d4Pass =
    customFieldServiceSrc.includes("SUPPORTED_ENTITY_TYPES: readonly CustomEntityType[] = ['item']") &&
    /`?item`?\s*فقط/.test(waveAChanges) &&
    waveAChanges.includes('غير منفذة') &&
    waveAChanges.includes('supplier') &&
    waveAChanges.includes('customer') &&
    waveAChanges.includes('document') &&
    waveAChanges.includes('AN-CUSTOM-FIELDS-8');

  assertCheck(
    'D4',
    'Custom fields scope documented in WAVE-A-CHANGES.md with item فقط, غير منفذة for supplier/customer/document, and AN-CUSTOM-FIELDS-8 expansion pattern',
    d4Pass
  );

  console.log(`\n=== Verification Summary: Passed: ${passed} | Failed: ${failed} ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

run();
