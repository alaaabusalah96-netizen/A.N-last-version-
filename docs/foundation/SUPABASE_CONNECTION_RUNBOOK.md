# Supabase / Remote PostgreSQL Connection Runbook

## 1. Safety First
- Always test connection and migrations on a separate staging/development Supabase project before touching production.
- Never disable SSL or certificate verification.

## 2. Roles & Permissions Separation
- Migrations and schema provisioning (`migrate.ts`, `provisionAppRole.ts`) must run using the owner/migration role via direct connection or session pooler.
- The runtime application must connect exclusively using the least-privilege `an_app` role. Transaction poolers (`pgBouncer`) are permitted for the runtime app connection.

## 3. SSL / CA Certificate Configuration
- Download the provider CA certificate (e.g. Supabase CA certificate) and provide it via `DATABASE_SSL_CA` (raw PEM string) or `DATABASE_SSL_CA_FILE` (absolute path to PEM file).
- Disabling SSL or setting `DATABASE_SSL_REJECT_UNAUTHORIZED=false` is strictly forbidden and rejected in production.

## 4. Production Environment Hardening
- Set `NODE_ENV=production`.
- Provide explicit `CORS_ORIGINS` for CSRF origin protection.
- Ensure Data API exposure guard (`dataApiGuard`) verifies that `an_app` does not inherit administrative roles (`service_role`, `supabase_admin`) and preserves Supabase default roles (`anon`, `authenticated`, `service_role`) intact without disruption.

## 5. Test Suite Caveat
- The foundation test battery and persistent/RLS tests leave test records and audit logs in the database. Do not run the test battery against a live production database.
