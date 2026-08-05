DROP INDEX IF EXISTS work_plans_cancel_requested_idx;
ALTER TABLE work_plans
  DROP COLUMN IF EXISTS cancel_requested_by,
  DROP COLUMN IF EXISTS cancel_requested_at;
