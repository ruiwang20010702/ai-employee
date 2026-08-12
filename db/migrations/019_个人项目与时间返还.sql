CREATE TABLE time_return_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  work_plan_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
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
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'confirmed', 'rejected')
  ),
  proposed_by TEXT NOT NULL,
  confirmed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT time_return_entries_plan_unique UNIQUE (tenant_id, work_plan_id),
  CONSTRAINT time_return_entries_plan_fkey
    FOREIGN KEY (tenant_id, work_plan_id)
    REFERENCES work_plans (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX time_return_entries_project_idx
ON time_return_entries (tenant_id, project_id, status, updated_at DESC);
