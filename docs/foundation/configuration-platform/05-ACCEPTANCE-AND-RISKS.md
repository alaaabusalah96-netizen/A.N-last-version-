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
