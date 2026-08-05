ALTER TABLE work_plans
  ADD COLUMN execution_owner TEXT,
  ADD COLUMN lease_expires_at TIMESTAMPTZ;

CREATE INDEX work_plans_execution_lease_idx
ON work_plans (tenant_id, lease_expires_at)
WHERE status IN ('executing', 'verifying');
