# Acceptance Rows Evidence: AN-CI-MISSING-SCRIPTS-RESTORE-1

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **S1** | `scripts/provisionAppRole.ts` exists (Priority 1) | **PASS** | File check in `verifyCiMissingScriptsRestore1.ts` |
| **S2** | `scripts/runFoundationBattery.ts` exists (Priority 2) | **PASS** | File check in `verifyCiMissingScriptsRestore1.ts` |
| **S3** | `scripts/verifyLocal.ts` exists (Priority 3) | **PASS** | File check in `verifyCiMissingScriptsRestore1.ts` |
| **S4** | Supporting libraries in `scripts/lib/` exist | **PASS** | Path checks in `verifyCiMissingScriptsRestore1.ts` |
| **S5** | Zero missing scripts from `package.json` | **PASS** | Complete script scan in `verifyCiMissingScriptsRestore1.ts` |
| **S6** | `foundation-ci.yml` retained without removing any steps | **PASS** | Workflow inspection in `verifyCiMissingScriptsRestore1.ts` |
| **S7** | `AI_PROJECT_STATE.md` records `AN-CI-MISSING-SCRIPTS-RESTORE-1` | **PASS** | State ledger check in `verifyCiMissingScriptsRestore1.ts` |
