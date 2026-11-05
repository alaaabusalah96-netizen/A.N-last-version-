# AN-FOUNDATION-SECURITY-REPAIR-7 Results Report

## Package Overview
- **Package**: AN-FOUNDATION-SECURITY-REPAIR-7
- **Type**: LEAN / Foundation Security Repair
- **Baseline Commit**: `5cf2dc502e358b5746d0f5973d47554d0da8cdc3`
- **Branch**: main
- **Status**: IMPLEMENTED / CI_STATUS=PENDING

---

## 1. Objectives & Implemented Fixes

### A. FIX 1 — Safe Application Role Provisioning (`scripts/provisionAppRole.ts`)
- Removed all logic modifying Supabase built-in roles (`anon`, `authenticated`, `service_role`).
- Removed `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`. Global PUBLIC privileges are untouched.
- Provisioning affects only the dedicated `APP_DB_USER` (`an_app`).
- Configured role attributes with `LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`.
- Revoked prior direct memberships, table, sequence, and schema privileges of `an_app` before re-granting least-privilege access.
- Retained SCRAM-SHA-256 verifier generation and strict username regex `/^[a-z_][a-z0-9_]{0,62}$/`.
- Sanitized sensitive data (passwords, SCRAM verifiers, postgres connection strings) in error logs.

### B. FIX 2 — Fail-Closed Data API Guard (`src/server/db/dataApiGuard.ts`)
- Rewrote `assertNoDataApiExposure` to be strictly fail-closed.
- Targets untrusted Data API roles (`anon`, `authenticated`). Excludes `service_role`.
- Checks effective privileges: schema CREATE, public tables/views (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER), public sequences (USAGE, SELECT, UPDATE), and public callable functions (EXECUTE, excluding trigger functions).
- Added `requireRoles` option (`true` by default). Any query error throws a sanitized fail-closed error.

### C. FIX 3 — Multi-Level Runtime Role Guard (`src/server/db/roleGuard.ts`)
- Retained direct attribute checks: `rolsuper`, `rolbypassrls`, `rolcreatedb`, `rolcreaterole`, `rolreplication`.
- Enforced multi-level nested membership checks using `pg_has_role(current_user, r.oid, 'MEMBER')`.
- Protected roles list: `service_role`, `supabase_admin`, `postgres`, `authenticator`, `anon`, `authenticated`, `pg_read_all_data`, `pg_write_all_data`, `pg_execute_server_program`, `pg_read_server_files`, `pg_write_server_files`.
- Rejects table owners in public schema.
- Fail-closed on unverifiable roles or query errors with sanitized error messages.

### D. FIX 4 — Provisioning Verification Suite (`scripts/verifyProvisioning.ts`)
- Captures both `stdout` and `stderr` using `spawnSync`.
- Replaced ambiguous SQL columns with explicit table aliases.
- Uses `URL` API for connection strings supporting both `postgres://` and `postgresql://`.
- Implemented built-in role preservation snapshot tests: compares before and after attributes, memberships, and privileges of `anon`, `authenticated`, and `service_role`.
- Restored tests: login, DDL prohibitions (`CREATE DATABASE`, `CREATE ROLE`, `CREATE TABLE`, `TRUNCATE`), idempotency, input validation, and credential leak checks.
- Clean reverse-order cleanup reporting failures.

### E. FIX 5 — Behavioral Data API Guard Verification (`scripts/verifyDataApiGuard.ts`)
- Converted to focused behavioral unit tests using mock `DbExecutor`.
- Tests 9 scenarios: zero exposure, anon SELECT, authenticated INSERT, sequence USAGE, function EXECUTE, schema CREATE, missing roles with `requireRoles=true`, fail-closed query failure, and `service_role` exclusion.
- Runs without requiring live `DATABASE_URL`.

### F. FIX 6 — Database Privileges Verification (`scripts/verifyDbPrivileges.ts`)
- Restored `current_user === APP_DB_USER` check.
- Restored direct attribute checks including `rolreplication`.
- Restored multi-level membership check using `pg_has_role` across all protected administrative roles.
- Retained DDL prohibition tests with safe object cleanup.

### G. FIX 7 — Nested Role Guard Verification (`scripts/verifyRoleGuard.ts`)
- Implemented three-level nested membership chain test: `privileged_root` (SUPERUSER, NOLOGIN) -> `intermediate_role` (NOLOGIN) -> `application_leaf` (LOGIN).
- Uses `URL` API for connection strings.
- Tests normal role pass, direct superuser rejection, nested membership rejection, fail-closed query failure, and role name leakage checks.
- Cleans up roles in reverse dependency order.

### H. FIX 8 — Test Safety: Remote Database Prevention
- `scripts/runFoundationBattery.ts`: Refuses non-loopback hosts for `DATABASE_URL` and `MIGRATION_DATABASE_URL` (permits only `localhost`, `127.0.0.1`, `::1`).
- `scripts/ciSimulateManagedPg.ts`: Enforces the same loopback-only check.

---

## 2. Verification Summary
- **TypeScript Error Count Before**: 0
- **TypeScript Error Count After**: 0 (`npm run typecheck` passed cleanly)
- **Application Build**: PASS (`npm run build` completed cleanly)
- **DataApiGuard Behavioral Test**: 9/9 PASS (100%)
- **Foundation Battery**: PASS on all static & behavioral tests; live tests cleanly BLOCKED due to no local database.
- **Supabase**: NOT CONNECTED / NOT MODIFIED.
- **P05_STARTED**: NO.
