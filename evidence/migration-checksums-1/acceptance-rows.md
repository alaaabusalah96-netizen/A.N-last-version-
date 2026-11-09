# Acceptance Rows Evidence: AN-MIGRATION-CHECKSUMS-1

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **C1** | `schema_migrations` created on new DB includes `checksum` column | **PASS** | Verification in `verifyMigrationChecksums1.ts` |
| **C2** | Upgrading existing table without `checksum` column preserves records | **PASS** | Verification in `verifyMigrationChecksums1.ts` |
| **C3** | Backfill for all legacy applied migration records succeeds | **PASS** | Verification in `verifyMigrationChecksums1.ts` |
| **C4** | Every record has valid 64-char SHA-256 hex `checksum` | **PASS** | Regex match in `verifyMigrationChecksums1.ts` |
| **C5** | First-time migration application records `version` & `checksum` atomically | **PASS** | Verification in `verifyMigrationChecksums1.ts` |
| **C6** | Rerunning `migrate` executes idempotently without modifying checksums | **PASS** | Idempotency test in `verifyMigrationChecksums1.ts` |
| **C7** | Tampering stored checksum in database causes `migrate` to fail | **PASS** | Tampering test in `verifyMigrationChecksums1.ts` |
| **C8** | Modifying content of applied `.sql` file causes checksum mismatch & abort | **PASS** | File modification test in `verifyMigrationChecksums1.ts` |
| **C9** | Missing applied `.sql` file on disk causes fatal error & abort | **PASS** | Missing file test in `verifyMigrationChecksums1.ts` |
| **C10** | Failed migration transaction rolls back SQL & `schema_migrations` record | **PASS** | Rollback test in `verifyMigrationChecksums1.ts` |
| **C11** | `an_app` role cannot INSERT/UPDATE/DELETE on `schema_migrations` | **PASS** | Privilege checks in `verifyMigrationChecksums1.ts` |
| **C12** | Migration Owner has full DDL/DML privileges on `schema_migrations` | **PASS** | Privilege checks in `verifyMigrationChecksums1.ts` |
