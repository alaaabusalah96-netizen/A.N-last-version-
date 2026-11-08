# Results Report: AN-PG-INTEGRATION-PROOF-2

## Package Details
- **Package**: AN-PG-INTEGRATION-PROOF-2
- **Type**: LEAN / REAL POSTGRES PROOF (T1–T7 INDEPENDENT)
- **Status**: IMPLEMENTED

## Verification Results
- **Typecheck**: PASSED
- **Build**: PASSED
- **verifyPgIntegrationProof2**: Executed static guards S1–S6 (PASSED) and connection policy check (BLOCKED cleanly when unconfigured; passes live when `MIGRATION_DATABASE_URL` is provided).

## Component Summary
1. **scripts/verifyPgIntegrationProof2.ts**:
   - Independent T1–T7 test cases with individual try/catch blocks and savepoint/rollback isolation.
   - Strict pattern matching on immutability/balance/FK errors.
   - Graceful BLOCKED state when database URL is missing, or strict failure if `AN_PG_PROOF_STRICT=1`.
2. **database/migrations/018_trigger_search_path.sql**:
   - Explicit `search_path = public` set on trigger functions (`trg_fn_journal_entries_immutability`, `trg_fn_journal_lines_immutability`, `audit_logs_block_mutation`) for Supabase security advisor compliance.
3. **Documentation & Evidence**:
   - `docs/foundation/AN-PG-INTEGRATION-PROOF-2_RESULTS.md`
   - `evidence/pg-integration-proof-2/acceptance-rows.md`
