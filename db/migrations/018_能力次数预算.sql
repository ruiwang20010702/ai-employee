ALTER TABLE work_plans
ADD COLUMN authorization_hash TEXT;

ALTER TABLE work_plans
ADD COLUMN capability_budget_ciphertext TEXT;

LOCK TABLE work_plans IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM work_plans
    WHERE status IN ('executing', 'verifying')
      AND (authorization_hash IS NULL OR capability_budget_ciphertext IS NULL)
  ) THEN
    RAISE EXCEPTION 'Cannot migrate capability budgets while legacy work plans are executing';
  END IF;
END
$$;

UPDATE work_plan_steps AS step
SET status = 'cancelled', completed_at = now(), updated_at = now()
FROM work_plans AS plan
WHERE step.tenant_id = plan.tenant_id
  AND step.work_plan_id = plan.id
  AND step.status = 'pending'
  AND plan.status IN ('ready', 'awaiting_approval', 'approved')
  AND (plan.authorization_hash IS NULL OR plan.capability_budget_ciphertext IS NULL);

UPDATE work_plans
SET status = 'cancelled',
    cancel_requested_at = COALESCE(cancel_requested_at, now()),
    cancel_requested_by = COALESCE(cancel_requested_by, 'system:migration-018'),
    updated_at = now()
WHERE status IN ('ready', 'awaiting_approval', 'approved')
  AND (authorization_hash IS NULL OR capability_budget_ciphertext IS NULL);

ALTER TABLE work_plans
ADD CONSTRAINT work_plans_capability_budget_required_check CHECK (
  status NOT IN (
    'ready', 'awaiting_approval', 'approved', 'executing', 'verifying'
  )
  OR (
    authorization_hash IS NOT NULL
    AND capability_budget_ciphertext IS NOT NULL
  )
);

CREATE TABLE capability_budget_usage (
  tenant_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  project_id_ciphertext TEXT NOT NULL,
  authorization_hash TEXT NOT NULL,
  capability TEXT NOT NULL,
  limit_count INTEGER NOT NULL CHECK (limit_count > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_key, authorization_hash, capability)
);

CREATE INDEX capability_budget_usage_project_idx
ON capability_budget_usage (tenant_id, project_key, updated_at DESC);
