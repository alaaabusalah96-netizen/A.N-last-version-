# Results Report: AN-CI-PROOF-WIRE-1

## Package Details
- **Package**: AN-CI-PROOF-WIRE-1
- **Type**: LEAN / CI WIRE PROOF-2 INTO EXISTING WORKFLOW
- **Status**: IMPLEMENTED

## Verification Results
- **Typecheck**: PASSED
- **Build**: PASSED
- **verifyCiProofWire1**: PASSED (6/6 static assertions passed).

## Component Summary
1. **.github/workflows/foundation-ci.yml**:
   - Added PostgreSQL Integration Proof step executing `npm run test:pg-proof-2` with `AN_PG_PROOF_STRICT: "1"` against local Postgres service container.
2. **scripts/verifyCiProofWire1.ts**:
   - Static harness validating workflow configuration, script presence, and migration safety.
3. **Documentation & Evidence**:
   - `docs/foundation/AN-CI-PROOF-WIRE-1_RESULTS.md`
   - `evidence/ci-proof-wire-1/acceptance-rows.md`
