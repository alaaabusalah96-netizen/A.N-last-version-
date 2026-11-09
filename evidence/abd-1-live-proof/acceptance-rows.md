# Acceptance Rows Evidence: AN-FIX-ABD-1-LIVE-PROOF

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **S1** | ABD-1 membership gate present at HEAD | **PASS** | Source check in `verifyAbd1LiveProof.ts` |
| **S2** | ABD-1 dead executor removed at HEAD | **PASS** | Source check in `verifyAbd1LiveProof.ts` |
| **S3** | RBAC A cross-company query returns 403 FORBIDDEN | **PASS** | Verification in `verifyAbd1LiveProof.ts` |
| **S4** | RBAC B inactive membership query returns 403 FORBIDDEN | **PASS** | Verification in `verifyAbd1LiveProof.ts` |
| **S5** | RBAC C active member query returns 200 OK | **PASS** | Verification in `verifyAbd1LiveProof.ts` |
| **S6** | RBAC D platform_admin query returns 200 OK | **PASS** | Verification in `verifyAbd1LiveProof.ts` |
| **S7** | RBAC E non-existent company UUID returns 404 NOT_FOUND | **PASS** | Verification in `verifyAbd1LiveProof.ts` |
| **S8** | MIG010 absent function apply handles missing routine cleanly | **PASS** | Logic check in `verifyAbd1LiveProof.ts` |
| **S9** | MIG010 present function apply executes targeted revokes | **PASS** | Logic check in `verifyAbd1LiveProof.ts` |
