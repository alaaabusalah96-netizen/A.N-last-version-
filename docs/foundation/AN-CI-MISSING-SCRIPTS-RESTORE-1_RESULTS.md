# Results Report: AN-CI-MISSING-SCRIPTS-RESTORE-1

## Package Details
- **Package**: AN-CI-MISSING-SCRIPTS-RESTORE-1
- **Type**: CI & SCRIPT RECOVERY (restore all scripts deleted in commit c718317)
- **Status**: IMPLEMENTED

## Verification Results
- **Typecheck**: PASSED (0 errors)
- **Build**: PASSED
- **verifyCiMissingScriptsRestore1**: PASSED (7/7 assertions passed)

## Restored Scripts Inventory
All 28 missing scripts referenced in `package.json`, plus 3 supporting library files in `scripts/lib/` and 4 historical scaffold verify scripts, were restored from commit:
- **Source Commit**: `ad07ba9557a453705770988cf4c11f8a0f714cfe` (`ad07ba9`)
- **Source Commit Message**: "docs: update Supabase security boundary documentation"
- **Parent of deletion commit**: `c718317985a888838d50fcee42c3925de5f2cd34`

### Priority Files:
1. `scripts/provisionAppRole.ts` (Priority 1) - Restored
2. `scripts/runFoundationBattery.ts` (Priority 2) - Restored
3. `scripts/verifyLocal.ts` (Priority 3) - Restored

### Supporting Libraries:
- `scripts/lib/battery_exclusions.json` - Restored & updated with post-foundation verification exclusions
- `scripts/lib/localPg.ts` - Restored
- `scripts/lib/testkit.ts` - Restored

### Verification Scripts:
- `scripts/verifyAuthSecurity.ts` - Restored
- `scripts/verifyBatteryIntegrity.ts` - Restored
- `scripts/verifyCompanyAtomicity.ts` - Restored
- `scripts/verifyDataApiGuard.ts` - Restored
- `scripts/verifyDbConfig.ts` - Restored
- `scripts/verifyDbPrivileges.ts` - Restored
- `scripts/verifyExecutorImports.ts` - Restored
- `scripts/verifyExecutorLifecycle.ts` - Restored
- `scripts/verifyFixDbWiring.ts` - Restored
- `scripts/verifyFixRbacCompanies.ts` - Restored
- `scripts/verifyForbiddenPatterns.ts` - Restored
- `scripts/verifyHttpSecurity.ts` - Restored
- `scripts/verifyMigration010.ts` - Restored
- `scripts/verifyMigrations.ts` - Restored
- `scripts/verifyNoMemoryFallback.ts` - Restored
- `scripts/verifyP01Scaffold.ts` - Restored
- `scripts/verifyP02aDbFoundation.ts` - Restored
- `scripts/verifyP03AuthCore.ts` - Restored
- `scripts/verifyP04OrgRbac.ts` - Restored
- `scripts/verifyPersistence.ts` - Restored
- `scripts/verifyProvisioning.ts` - Restored
- `scripts/verifyPublicAssets.ts` - Restored
- `scripts/verifyRbacHttp.ts` - Restored
- `scripts/verifyRepair2.ts` - Restored
- `scripts/verifyRlsCoverage.ts` - Restored
- `scripts/verifyRoleGuard.ts` - Restored
- `scripts/verifyTenantHttp.ts` - Restored
- `scripts/verifyTenantIsolation.ts` - Restored
- `scripts/verifyTenantScopeMiddleware.ts` - Restored

## Backward Compatibility Fixes:
- `src/server/org/membershipRepository.ts`: Added backward-compatible `setMembershipStatus(userId, companyId, isActive)` alongside `setMembershipStatusById` to satisfy `verifyRbacHttp.ts`.
