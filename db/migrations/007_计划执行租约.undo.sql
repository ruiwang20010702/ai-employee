DROP INDEX IF EXISTS work_plans_execution_lease_idx;
ALTER TABLE work_plans
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS execution_owner;
