ALTER TABLE work_plans
  ADD COLUMN cancel_requested_at TIMESTAMPTZ,
  ADD COLUMN cancel_requested_by TEXT;

CREATE INDEX work_plans_cancel_requested_idx
ON work_plans (tenant_id, cancel_requested_at)
WHERE status IN ('executing', 'verifying') AND cancel_requested_at IS NOT NULL;
