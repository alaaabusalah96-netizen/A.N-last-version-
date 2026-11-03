ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT;

-- Strict RLS Policy for tenant_demo_items using explicit UUID casting
DROP POLICY IF EXISTS tenant_demo_isolation ON tenant_demo_items;
CREATE POLICY tenant_demo_isolation ON tenant_demo_items FOR ALL
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Restrict deletions of actors/companies that have audit entries
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_user_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES platform_users(id) ON DELETE RESTRICT;

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_company_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;

-- Append-only trigger on audit_logs
CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_mutation();

-- Index for login_rate_events lookup efficiency
CREATE INDEX IF NOT EXISTS idx_rate_events_key_success_time ON login_rate_events(rate_key, success, attempt_at DESC);
