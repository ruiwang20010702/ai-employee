CREATE TABLE shadow_time_return_entries (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  project_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  repository_commit TEXT NOT NULL,
  baseline_minutes INTEGER NOT NULL CHECK (
    baseline_minutes BETWEEN 1 AND 2400
  ),
  human_active_minutes INTEGER NOT NULL CHECK (
    human_active_minutes BETWEEN 0 AND baseline_minutes
  ),
  returned_minutes INTEGER NOT NULL CHECK (
    returned_minutes = baseline_minutes - human_active_minutes
  ),
  baseline_method TEXT NOT NULL CHECK (
    baseline_method IN ('measured', 'user_confirmed')
  ),
  outcome_evidence_ciphertext TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, evidence_sha256)
);

CREATE INDEX shadow_time_return_entries_project_idx
ON shadow_time_return_entries (tenant_id, project_id, confirmed_at DESC);
