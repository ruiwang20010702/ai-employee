UPDATE work_plans SET status = 'cancelled' WHERE status = 'superseded';

DROP INDEX IF EXISTS work_plans_single_revision_idx;

ALTER TABLE work_plans
  DROP CONSTRAINT IF EXISTS work_plans_supersedes_fkey,
  DROP CONSTRAINT work_plans_status_check,
  DROP COLUMN supersedes_work_plan_id,
  DROP COLUMN revision_actor;

ALTER TABLE work_plans
  ADD CONSTRAINT work_plans_status_check CHECK (
    status IN (
      'ready', 'awaiting_approval', 'approved', 'rejected',
      'executing', 'verifying', 'completed', 'failed', 'cancelled'
    )
  );
