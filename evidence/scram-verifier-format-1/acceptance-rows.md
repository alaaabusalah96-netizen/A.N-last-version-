# Acceptance Rows Evidence: AN-SCRAM-VERIFIER-FORMAT-1

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **V1** | Matches exact PostgreSQL SCRAM format | **PASS** | Regex match in `verifyScramVerifierFormat1.ts` |
| **V2** | Separator between salt and storedKey is `$` | **PASS** | Delimiter check in `verifyScramVerifierFormat1.ts` |
| **V3** | Salt is exactly 16 bytes | **PASS** | Length check in `verifyScramVerifierFormat1.ts` |
| **V4** | StoredKey is exactly 32 bytes | **PASS** | Length check in `verifyScramVerifierFormat1.ts` |
| **V5** | ServerKey is exactly 32 bytes | **PASS** | Length check in `verifyScramVerifierFormat1.ts` |
| **V6** | Mathematical reproducibility per PostgreSQL spec | **PASS** | PBKDF2/HMAC check in `verifyScramVerifierFormat1.ts` |
| **V7** | Correct password verifies against generated SCRAM verifier | **PASS** | SCRAM RFC 5802 simulation in `verifyScramVerifierFormat1.ts` |
| **V8** | Incorrect password is strictly rejected | **PASS** | SCRAM RFC 5802 simulation in `verifyScramVerifierFormat1.ts` |
| **V9** | State ledger records package | **PASS** | File check in `verifyScramVerifierFormat1.ts` |
