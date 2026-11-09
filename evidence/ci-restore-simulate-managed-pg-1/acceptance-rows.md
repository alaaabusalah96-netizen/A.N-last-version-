# Acceptance Rows Evidence: AN-CI-RESTORE-SIMULATE-MANAGED-PG-1

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **S1** | `scripts/ciSimulateManagedPg.ts` exists | **PASS** | File check in `verifyCiRestoreSimulateManagedPg1.ts` |
| **S2** | `package.json` points to `scripts/ciSimulateManagedPg.ts` | **PASS** | Script check in `verifyCiRestoreSimulateManagedPg1.ts` |
| **S3** | `scripts/ciSimulateManagedPg.ts` enforces loopback / localhost host restriction | **PASS** | Host validation check in `verifyCiRestoreSimulateManagedPg1.ts` |
| **S4** | `foundation-ci.yml` still executes `npm run ci:simulate-managed-pg` | **PASS** | Workflow step retention check in `verifyCiRestoreSimulateManagedPg1.ts` |
| **S5** | `AI_PROJECT_STATE.md` records `AN-CI-RESTORE-SIMULATE-MANAGED-PG-1` | **PASS** | State ledger check in `verifyCiRestoreSimulateManagedPg1.ts` |
