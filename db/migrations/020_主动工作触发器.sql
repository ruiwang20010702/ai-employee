CREATE TABLE work_triggers (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'event')),
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  definition_ciphertext TEXT NOT NULL,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX work_triggers_due_idx
ON work_triggers (tenant_id, status, next_run_at)
WHERE kind = 'schedule';

CREATE TABLE work_trigger_runs (
  tenant_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  run_key TEXT NOT NULL,
  work_plan_id TEXT,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'failed')),
  error_ciphertext TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, trigger_id, run_key),
  FOREIGN KEY (tenant_id, trigger_id) REFERENCES work_triggers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, work_plan_id) REFERENCES work_plans (tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX work_trigger_runs_recent_idx
ON work_trigger_runs (tenant_id, trigger_id, created_at DESC);
