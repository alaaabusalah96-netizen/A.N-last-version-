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
  - Both variables must be provided together; configuring only one fails startup immediately.
  - Password must be at least 12 characters.
  - Never logged in plaintext or exposed in error messages.
  - If bootstrap fails (due to database unavailability or conflict), the server halts with `process.exit(1)` and refuses to listen on HTTP.
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
