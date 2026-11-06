-- ==============================================================================
-- Migration 010: Security & RLS Baseline
-- Package: AN-FOUNDATION-SECURITY-BASELINE-1
-- 
-- 1. Enforces Row Level Security (RLS) across all application tables.
-- 2. Defines explicit least-privilege policies for role 'an_app'.
-- 3. Revokes unauthorized access from Data API roles 'anon' and 'authenticated'.
-- 4. Enforces secure default privileges for objects created in schema public.
-- ==============================================================================

-- 1. Ensure target application role exists idempotently for policy binding
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'an_app') THEN
    CREATE ROLE an_app WITH NOLOGIN NOINHERIT;
  END IF;
END $$;

-- 2. Enable Row Level Security (RLS) on all application tables
ALTER TABLE platform_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_rate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_demo_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_demo_items FORCE ROW LEVEL SECURITY;

-- 3. Explicit RLS Policies for an_app on Global and Shared Tables

-- platform_users (Global)
DROP POLICY IF EXISTS platform_users_app_policy ON platform_users;
CREATE POLICY platform_users_app_policy ON platform_users
  TO an_app
  USING (true)
  WITH CHECK (true);

-- companies (Global)
DROP POLICY IF EXISTS companies_app_policy ON companies;
CREATE POLICY companies_app_policy ON companies
  TO an_app
  USING (true)
  WITH CHECK (true);

-- company_memberships (Shared)
DROP POLICY IF EXISTS company_memberships_app_policy ON company_memberships;
CREATE POLICY company_memberships_app_policy ON company_memberships
  TO an_app
  USING (true)
  WITH CHECK (true);

-- user_sessions (Global)
DROP POLICY IF EXISTS user_sessions_app_policy ON user_sessions;
CREATE POLICY user_sessions_app_policy ON user_sessions
  TO an_app
  USING (true)
  WITH CHECK (true);

-- login_rate_events (Global)
DROP POLICY IF EXISTS login_rate_events_app_policy ON login_rate_events;
CREATE POLICY login_rate_events_app_policy ON login_rate_events
  TO an_app
  USING (true)
  WITH CHECK (true);

-- schema_migrations (Global - SELECT only)
DROP POLICY IF EXISTS schema_migrations_app_policy ON schema_migrations;
CREATE POLICY schema_migrations_app_policy ON schema_migrations
  FOR SELECT
  TO an_app
  USING (true);

-- audit_logs (Shared - SELECT and INSERT only, append-only)
DROP POLICY IF EXISTS audit_logs_app_select_policy ON audit_logs;
CREATE POLICY audit_logs_app_select_policy ON audit_logs
  FOR SELECT
  TO an_app
  USING (true);

DROP POLICY IF EXISTS audit_logs_app_insert_policy ON audit_logs;
CREATE POLICY audit_logs_app_insert_policy ON audit_logs
  FOR INSERT
  TO an_app
  WITH CHECK (true);

-- tenant_demo_items (Tenant - strictly isolated by app.current_tenant_id)
DROP POLICY IF EXISTS tenant_demo_isolation ON tenant_demo_items;
CREATE POLICY tenant_demo_isolation ON tenant_demo_items
  TO an_app
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 4. Enforce strict table privileges on audit_logs and schema_migrations
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM an_app;
REVOKE ALL ON TABLE schema_migrations FROM an_app;
GRANT SELECT ON TABLE schema_migrations TO an_app;

-- 5. Revoke unnecessary application-table privileges from anon and authenticated
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon;
    REVOKE CREATE ON SCHEMA public FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM authenticated;
    REVOKE CREATE ON SCHEMA public FROM authenticated;
  END IF;
END $$;

-- 6. Configure default privileges for objects created by migration owner
DO $$
BEGIN
  -- Prevent future application tables, sequences, and routines from exposing to anon & authenticated
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;', CURRENT_USER);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;', CURRENT_USER);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon, authenticated;', CURRENT_USER);
  END IF;

  -- Revoke global PUBLIC execution default on routines in schema public
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON ROUTINES FROM PUBLIC;', CURRENT_USER);

  -- Ensure future tables and sequences created by migration owner grant required least-privilege to an_app
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO an_app;', CURRENT_USER);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO an_app;', CURRENT_USER);
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END $$;
