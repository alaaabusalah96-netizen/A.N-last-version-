-- Audit logs table for auth and administrative events
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  action VARCHAR(150) NOT NULL,
  entity_type VARCHAR(100),
  entity_id VARCHAR(100),
  ip_address VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_company ON audit_logs(company_id);

-- Login rate limiting events table for persistent tracking
CREATE TABLE IF NOT EXISTS login_rate_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_key VARCHAR(255) NOT NULL,
  attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  success BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_rate_events_key_time ON login_rate_events(rate_key, attempt_at DESC);
