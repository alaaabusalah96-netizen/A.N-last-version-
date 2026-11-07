# Supabase / Remote PostgreSQL Connection Runbook

## 1. Safety & Production Guardrails
- Always test connection, migrations, and role provisioning on a separate disposable/staging database before touching production.
- **Never run foundation test batteries against live production databases.** Test batteries generate disposable tenants, test audit entries, and benchmark loads.
- Disabling SSL or setting `DATABASE_SSL_REJECT_UNAUTHORIZED=false` is strictly forbidden and rejected in production.
- **Never commit production credentials or secrets to source control.**

## 2. Roles & Permissions Separation
The architecture strictly enforces two separate database connections:
1. **`DATABASE_URL` (Runtime Application Connection)**:
   - Must connect exclusively using the least-privilege `an_app` role.
   - Used by the Express server, services, and tenant resolvers at runtime.
   - `an_app` possesses NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, and NOBYPASSRLS.
   - Transaction poolers (`pgBouncer` / Supavisor on port 6543 or 5432) are permitted.
2. **`MIGRATION_DATABASE_URL` (Privileged Migration Connection)**:
   - Used exclusively for schema migrations (`npm run migrate`) and role provisioning (`npm run db:provision-app-role`).
   - Must connect as the database owner / migration user (e.g. `postgres`).
   - **`MIGRATION_DATABASE_URL` must never be used as a runtime fallback.**
3. **`APP_DB_PASSWORD`**:
   - Provisioning input only. Defines the password for the `an_app` role.
   - Must be at least 16 printable ASCII characters.

## 3. Platform Admin Bootstrap
- **`PLATFORM_ADMIN_USERNAME`** and **`PLATFORM_ADMIN_PASSWORD`**:
  - Used for the one-time initial platform administrator account bootstrap.
  - Both variables must be provided together; configuring only one fails startup immediately across all environments.
  - Password must be at least 12 characters.
  - Never logged in plaintext or exposed in error messages.
  - In development/preview, if `DATABASE_URL` is absent, the server emits a clear warning and skips the bootstrap attempt to allow the dev server to start without crashing.
  - In production, `DATABASE_URL` is strictly required and missing database configuration or bootstrap failure halts with `process.exit(1)`.
  - Ordinary users are never automatically promoted to `platform_admin`.

## 4. Data API Roles & Security Boundary
- **`anon` & `authenticated` (Untrusted Data API Roles)**:
  - Untrusted client roles used by Supabase PostgREST / Data APIs.
  - All application tables, sequences, and callable functions are completely revoked from these roles.
  - Schema `public` `CREATE` privilege is revoked.
  - The runtime Data API guard (`dataApiGuard`) fails closed if any table, sequence, or callable function privilege is exposed to `anon` or `authenticated`.
- **`service_role` (Trusted Server Role)**:
  - A secret-only administrative Supabase server role (bypasses RLS).
  - Must never be exposed to frontend code or browser clients.
  - Kept distinct and excluded from untrusted public Data API role checks.

## 5. RLS Policy Requirements by Table Scope
As classified in `database/table_ownership.json`:
1. **Global Tables (`platform_users`, `companies`, `user_sessions`, `login_rate_events`, `schema_migrations`)**:
   - RLS enabled on all tables.
   - Must not contain `company_id`.
   - Explicit RLS policy targeting role `an_app`.
   - `schema_migrations` must remain strictly SELECT-only for `an_app`.
2. **Shared Tables (`company_memberships`, `audit_logs`)**:
   - RLS enabled on all tables.
   - Explicit RLS policy targeting role `an_app`.
   - `audit_logs` is append-only: granted SELECT and INSERT only to `an_app` (UPDATE, DELETE, TRUNCATE forbidden).
3. **Tenant Tables (`tenant_demo_items`, and all future tenant tables)**:
   - `company_id UUID NOT NULL` with active foreign key referencing `companies(id)`.
   - RLS enabled and **`FORCE ROW LEVEL SECURITY`** enabled.
   - Explicit policy targeting `an_app` enforcing `app.current_tenant_id` in both `USING` and `WITH CHECK`.
   - Permissive global policies (`USING true`) are strictly forbidden on tenant tables.

## 6. Registering New Tenant Tables
1. Add the table definition with `company_id UUID NOT NULL REFERENCES companies(id)`.
2. Enable and force RLS:
   ```sql
   ALTER TABLE <new_table> ENABLE ROW LEVEL SECURITY;
   ALTER TABLE <new_table> FORCE ROW LEVEL SECURITY;
   ```
3. Add isolated tenant policy for `an_app`:
   ```sql
   CREATE POLICY <new_table>_tenant_isolation ON <new_table>
     TO an_app
     USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
     WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
   ```
4. Register the table in `database/table_ownership.json` under scope `"tenant"`.
5. Run `npm run test:rls-coverage` to verify policy and catalog compliance.

## 7. SSL / CA Certificate Configuration
- Download provider CA certificate (e.g. Supabase Root 2021 CA) and provide it via `DATABASE_SSL_CA` or `DATABASE_SSL_CA_FILE`.
- The connection resolver normalizes single-line PEM certificates and strips template brackets automatically.

## 8. Trusted Backend Security Boundary
- **Role `an_app` Identity**: `an_app` is a shared trusted backend database identity used by the application server.
- **Row-Wide Policies**: Global and shared table policies using `USING (true)` and `WITH CHECK (true)` permit row-wide access to that trusted backend identity.
- **Server Enforcement Mandatory**: These policies do **NOT** independently enforce per-user or per-company authorization at the database layer.
- **Authentication & Authorization**: Server-side authentication, role-based access control (RBAC), and company-membership authorization checks are strictly mandatory before executing database operations.
- **Credential Protection**: `an_app` credentials must **never** be exposed to browsers or client-side code.
- **Tenant Table Isolation**: Tenant-specific tables must enforce strict tenant isolation via `company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid` on both `USING` and `WITH CHECK`.

## 9. Dated Database & Routine Inspection Snapshot (as of 2026-11-06)
*(Note: This section documents a dated read-only snapshot from 2026-11-06, not a active live database state.)*

- **Database Inspection Snapshot (2026-11-06)**:
  - **Applied Migrations**: Migrations 001 through 009 were recorded as applied in `schema_migrations`.
  - **Pending Migration**: Migration 010 (`010_security_rls_baseline.sql`) was pending and has **NOT** been applied to the live database.
  - **RLS State**: RLS was enabled on all 8 inspected tables. Seven tables had 0 policies at inspection time; `tenant_demo_items` had 1 existing tenant policy.
- **Routine Security Snapshot (2026-11-06)**:
  - Inspected routines `public.audit_logs_block_mutation()` and `public.rls_auto_enable()` were observed to have `PUBLIC`, `anon`, and `authenticated` `EXECUTE` grants.
  - Intended Migration 010 hardening includes targeted `EXECUTE` revocations for `public.audit_logs_block_mutation()` and `public.rls_auto_enable()`.
  - `public.audit_logs_block_mutation()` `search_path` is pinned to `pg_catalog`.
  - `public.rls_auto_enable()` event-trigger definition and behavior are preserved without `DROP` or replacement (its `search_path` was already `pg_catalog`).
  - *These routine revocations are present in the pending migration file only and are NOT active in Supabase until Migration 010 is safely validated and applied.*

## 10. Default Privileges & Data API Guard
- **Default Privileges Ownership Scope**:
  - `ALTER DEFAULT PRIVILEGES` applies to objects created by the specified owner role (e.g. `CURRENT_USER`).
  - It does not automatically cover objects created by every possible database owner.
  - Migration 010 default privileges must be tested against the actual intended migration/provisioning owner.
  - Failure to apply required default privileges must fail visibly (fail-closed, without broad `undefined_object` or `WHEN OTHERS` exception swallowing).
- **Data API Guard Boundary**:
  - The application-side `dataApiGuard` dynamically checks routines in schema `public` for unauthorized `anon` and `authenticated` `EXECUTE` exposure.
  - This application runtime guard provides fail-closed defence-in-depth, but does **NOT** replace database-level ACL verification and policy enforcement.

## 11. Pre-Deployment Validation Gate & Known Blockers

### Required Validation Gate (Disposable PostgreSQL)
Before applying Migration 010 to the production Supabase project:
1. Obtain an isolated, disposable PostgreSQL environment.
2. Reproduce the relevant existing schema, tables, and roles.
3. Test Migration 010 from a clean state.
4. Verify idempotency by re-running Migration 010.
5. Verify `an_app` role attributes (`NOLOGIN`, `NOINHERIT`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`).
6. Verify exact table grants and RLS policies for `an_app`.
7. Verify tenant isolation on `tenant_demo_items`.
8. Verify `audit_logs` append-only behavior (`SELECT` + `INSERT` only, `UPDATE`/`DELETE`/`TRUNCATE` revoked).
9. Verify `schema_migrations` `SELECT`-only behavior for `an_app`.
10. Verify routine ACLs for `PUBLIC`, `anon`, `authenticated`, `an_app`, and `service_role`.
11. Verify the `rls_auto_enable` event trigger remains installed and operational.
12. Verify default privileges for each intended object-creating role.
13. Capture actual SQL test outputs for audit logs.

*Production application of Migration 010 MUST remain blocked until disposable PostgreSQL validation passes and explicit human approval is obtained.*

### Known Blockers
- **Migration Unapplied**: No proof yet that Migration 010 has been applied to the production Supabase project.
- **Provisioning Unverified**: No proof yet that `an_app` provisioning has been executed on the production project.
- **Runtime Connection Unverified**: No proof yet that the live application runtime is connected via `DATABASE_URL` using `an_app`.
- **Integration Test Unverified**: No proof yet of successful isolated PostgreSQL integration testing.
- **Absent Scripts**: `scripts/runReconcileAuditB.ts` is absent and must not be invented or referenced.

## Live connection checklist (operator)

*Note: This checklist is operational guidance; ticking is done by the operator outside git when applicable.*

- [x] MIGRATION_DATABASE_URL set in runtime secrets (not in git)
- [x] APP_DB_USER / APP_DB_PASSWORD set
- [x] DATABASE_URL uses application role after provision
- [x] DATABASE_SSL=require
- [x] DATABASE_SSL_CA or DATABASE_SSL_CA_FILE configured when required
- [x] CSRF_SECRET set (≥32 chars)
- [x] CORS_ORIGINS set to real app origins
- [x] PLATFORM_ADMIN_USERNAME / PLATFORM_ADMIN_PASSWORD set
- [x] migrate completed once on target project
- [x] db:provision-app-role completed once on target project
- [x] Platform admin can log in
- [x] Foundation battery NOT run against live DB
