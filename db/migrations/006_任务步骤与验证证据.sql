CREATE TABLE work_plan_steps (
  tenant_id TEXT NOT NULL,
  work_plan_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  capability TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'executing', 'verifying', 'completed', 'failed', 'cancelled')
  ),
  evidence_ciphertext TEXT,
  error_ciphertext TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, work_plan_id, step_id),
  CONSTRAINT work_plan_steps_plan_fkey
    FOREIGN KEY (tenant_id, work_plan_id)
    REFERENCES work_plans (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX work_plan_steps_status_idx
ON work_plan_steps (tenant_id, work_plan_id, position)
WHERE status <> 'completed';
