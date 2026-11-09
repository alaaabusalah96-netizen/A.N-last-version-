# Acceptance Rows Evidence: AN-CI-POSTGRES-SSL-1

| Assertion | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **S1** | `migrationRunner.ts` uses `buildPgConfig` | **PASS** | Static check in `verifyCiPostgresSsl1.ts` |
| **S2** | `migrationRunner.ts` delegates SSL to `buildPgConfig` | **PASS** | Static check in `verifyCiPostgresSsl1.ts` |
| **S3** | `foundation-ci.yml` contains `DATABASE_SSL: disable` | **PASS** | Static check in `verifyCiPostgresSsl1.ts` |
| **S4** | `foundation-ci.yml` runs `test:pg-proof-2` with `AN_PG_PROOF_STRICT` | **PASS** | Static check in `verifyCiPostgresSsl1.ts` |
| **S5** | `connection.ts` strictly forbids `DATABASE_SSL=disable` in production | **PASS** | Static check in `verifyCiPostgresSsl1.ts` |
| **S6** | `AI_PROJECT_STATE.md` records `AN-CI-POSTGRES-SSL-1` | **PASS** | Static check in `verifyCiPostgresSsl1.ts` |
