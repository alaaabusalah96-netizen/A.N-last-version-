-- Migration 061: Generic approval engine (AN-ERP-C1A)
-- A company can define, per document type, an ordered list of approval steps. Each step names the permission
-- an approver must hold. Policies are versioned (new version = new row, old versions kept). A request pins the
-- policy version it started under, so a later policy change never rewrites a decision already in progress.
-- Requests and decisions are append-only. The status (pending, approved, rejected) is derived from the decisions.

CREATE TABLE IF NOT EXISTS approval_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL CHECK (char_length(document_type) BETWEEN 1 AND 80),
  version INTEGER NOT NULL CHECK (version >= 1),
  steps JSONB NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 10),
  created_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_approval_policies_version UNIQUE (company_id, document_type, version),
  CONSTRAINT uq_approval_policies_id_company UNIQUE (id, company_id)
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL,
  document_id UUID NOT NULL,
  policy_id UUID NULL,
  steps JSONB NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 10),
  requested_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_approval_requests_id_company UNIQUE (id, company_id),
  CONSTRAINT fk_approval_requests_policy FOREIGN KEY (policy_id, company_id)
    REFERENCES approval_policies(id, company_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS approval_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  request_id UUID NOT NULL,
  step_no INTEGER NOT NULL CHECK (step_no >= 1),
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  decided_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_approval_decisions_step UNIQUE (request_id, step_no),
  CONSTRAINT ck_approval_decisions_reject_reason CHECK (decision = 'approve' OR (reason IS NOT NULL AND btrim(reason) <> '')),
  CONSTRAINT fk_approval_decisions_request FOREIGN KEY (request_id, company_id)
    REFERENCES approval_requests(id, company_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_approval_policies_lookup ON approval_policies (company_id, document_type, version DESC);
CREATE INDEX IF NOT EXISTS idx_approval_requests_doc ON approval_requests (company_id, document_type, document_id);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_request ON approval_decisions (company_id, request_id);

DO $do$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['approval_policies','approval_requests','approval_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format($p$CREATE POLICY %I ON %I TO an_app
      USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)$p$, t || '_tenant_isolation', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO an_app', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('CREATE OR REPLACE FUNCTION %I() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION ''%s rows are immutable (history is kept)''; END; $f$ LANGUAGE plpgsql', t || '_guard', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || t || '_guard', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION %I()', 'trg_' || t || '_guard', t, t || '_guard');
  END LOOP;
END
$do$;
