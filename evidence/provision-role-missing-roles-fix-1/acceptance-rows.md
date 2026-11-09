# Acceptance Rows Evidence: AN-PROVISION-ROLE-MISSING-ROLES-FIX-1

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **V1** | `scripts/provisionAppRole.ts` exists | **PASS** | File check in `verifyProvisionRoleMissingRolesFix1.ts` |
| **V2** | `protectedRoles` retains all 6 roles | **PASS** | Code scan in `verifyProvisionRoleMissingRolesFix1.ts` |
| **V3** | Checks role existence in `pg_roles` before `pg_has_role` | **PASS** | Code scan in `verifyProvisionRoleMissingRolesFix1.ts` |
| **V4** | Missing roles safely skipped without 42704 error | **PASS** | Unit logic simulation in `verifyProvisionRoleMissingRolesFix1.ts` |
| **V5** | When role exists and membership detected, fails with error | **PASS** | Unit logic simulation in `verifyProvisionRoleMissingRolesFix1.ts` |
| **V6** | When all roles exist with no membership, passes cleanly | **PASS** | Unit logic simulation in `verifyProvisionRoleMissingRolesFix1.ts` |
| **V7** | `foundation-ci.yml` retains Provision step intact | **PASS** | Workflow inspection in `verifyProvisionRoleMissingRolesFix1.ts` |
| **V8** | `AI_PROJECT_STATE.md` records `AN-PROVISION-ROLE-MISSING-ROLES-FIX-1` | **PASS** | State ledger check in `verifyProvisionRoleMissingRolesFix1.ts` |
