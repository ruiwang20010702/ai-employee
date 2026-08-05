ALTER TABLE work_plans
  DROP CONSTRAINT work_plans_status_check;

ALTER TABLE work_plans
  ADD CONSTRAINT work_plans_status_check CHECK (
    status IN (
      'ready', 'awaiting_approval', 'approved', 'rejected',
      'executing', 'verifying', 'completed', 'failed', 'cancelled',
      'superseded'
    )
  ),
  ADD COLUMN supersedes_work_plan_id TEXT,
  ADD COLUMN revision_actor TEXT,
  ADD CONSTRAINT work_plans_supersedes_fkey
    FOREIGN KEY (tenant_id, supersedes_work_plan_id)
    REFERENCES work_plans (tenant_id, id);

CREATE UNIQUE INDEX work_plans_single_revision_idx
ON work_plans (tenant_id, supersedes_work_plan_id)
WHERE supersedes_work_plan_id IS NOT NULL;
