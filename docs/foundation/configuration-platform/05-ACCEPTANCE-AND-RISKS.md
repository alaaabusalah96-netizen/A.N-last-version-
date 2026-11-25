# 05 - Acceptance and Risks

This document defines the quality gates for every implementation package in the configuration platform project.

## 1. Package Acceptance Checklist
Every implementation package (A1–C12) must meet the following 9 points before completion:

1. **Typecheck & Lint**: Zero TypeScript errors or lint violations.
2. **Build Success**: Production build (`npm run build`) passes.
3. **Tenancy Proof**: RLS is explicitly verified for all new tables.
4. **API Security**: Routes are protected by `requireAuth` and specific permissions.
5. **UI Consistency**: Follows `AppSidebar` vertical layout and Arabic first standards.
6. **Double-Entry Integrity**: If accounting is touched, the engine must still balance correctly.
7. **Idempotency**: Retrying operations (e.g., publishing a version) does not create duplicate or inconsistent state.
8. **Battery Green**: All existing and new foundation battery tests pass.
9. **No Regression**: Inventory and Ledger modules remain fully functional.

## 2. Risk Mitigation

| Risk | Mitigation Strategy |
| :--- | :--- |
| **Performance Latency** | Cache active configurations in memory on the server. Versioning ensures caches can be invalidated precisely. |
| **User Misconfiguration** | Mandatory dry-run and validation engine (A4). Always provide a "System Default" fallback. |
| **Complexity Overload** | Stick to the Wave strategy. Don't build Wave C features in Wave A. |
| **Insecure Metadata** | Never allow `eval()` or `new Function()`. Logic must be metadata-driven via pre-defined engines. |

## 3. Explicit Non-Goals
- **User-Defined Code**: We will NOT support uploading arbitrary JS or SQL snippets.
- **Bypassing RLS**: The configuration platform must NEVER create a way to bypass tenant isolation.
- **Direct DB Access**: Users do not get direct access to the configuration schema outside of controlled API/UI.
- **Demolishing Modules**: We will NOT rewrite the entire inventory or accounting core. We will extend them.

## Per-Package Acceptance Tests and Verified Status (as of 25 Nov 2026)
Status words: VERIFIED = a registered test script passes in CI. PARTIAL = built but part of the roadmap goal is missing. NOT BUILT. UNVERIFIED is never PASS.

| Package | Proof required | Test script | Status |
| --- | --- | --- | --- |
| A1-A4 Registry, versioning, validation | RLS, immutable versions, publish/rollback, validation without eval | verifyWaveACompletion1 (S1-S17, T1-T6 live) | VERIFIED |
| B1 Org Designer | Tree CRUD plus custom attributes and config overrides | verifyP1cOrgUnits1 (static checks) | PARTIAL: tree CRUD verified, custom attributes and overrides NOT BUILT |
| B2 Dynamic roles | Role rules, cache invalidation, catalog parity | verifyDynamicRoles5 (R1-R13) | VERIFIED |
| B3 Permission matrix UI | Matrix wired, 42 permissions parity | verifyDynamicRoles5 (R12, R13) | VERIFIED (UI checked statically, not in a browser) |
| B4 Scope assignment | Scope isolation, escalation block, expiry, RLS | verifyUserScopeIsolation6 (S1-S10) | VERIFIED |
| B5 Accounting mapping | Event catalog mapping to accounts | verifyGlMappingEvents7 | VERIFIED |
| B6 Config center | Draft, publish, rollback, change summary | verifyConfigCenter4, verifyConfigUi1 | VERIFIED |
| C6 Custom fields | Fields survive versions, tenant isolation | verifyCustomFields8 | VERIFIED |
| C1 Workflow engine | Generic approval engine (C1-a): versioned step policy, separation of duties, append-only decisions, audit | verifyApprovalEngine1 (A1-A14, live DB, mutation-checked) | PARTIAL: approval engine service verified; no HTTP API, no designer UI, not wired to any document yet; general state-transition engine NOT BUILT |
| C2-C5, C7-C12 | See roadmap acceptance hints | none yet | NOT BUILT |
| C13 Custody configuration | See roadmap acceptance hints | none yet | NOT BUILT |
