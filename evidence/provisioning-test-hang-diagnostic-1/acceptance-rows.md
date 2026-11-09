# Acceptance Rows Evidence: AN-PROVISIONING-TEST-HANG-DIAGNOSTIC-1

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **V1** | `scripts/verifyProvisioning.ts` exists | **PASS** | File check in `verifyProvisioningHangGuard1.ts` |
| **V2** | `connectionTimeoutMillis` configured on pg.Client | **PASS** | Source check in `verifyProvisioningHangGuard1.ts` |
| **V3** | `statement_timeout` configured on sessions | **PASS** | Source check in `verifyProvisioningHangGuard1.ts` |
| **V4** | `timeout: SPAWN_TIMEOUT_MS` on spawnSync calls | **PASS** | Source check in `verifyProvisioningHangGuard1.ts` |
| **V5** | Test stages instrumented with timing | **PASS** | Log analysis in `verifyProvisioningHangGuard1.ts` |
| **V6** | Client cleanup guaranteed in finally blocks | **PASS** | Code structure in `verifyProvisioningHangGuard1.ts` |
| **V7** | All 17 verification checks preserved | **PASS** | Count check in `verifyProvisioningHangGuard1.ts` |
| **V8** | `AI_PROJECT_STATE.md` records package | **PASS** | Ledger check in `verifyProvisioningHangGuard1.ts` |
