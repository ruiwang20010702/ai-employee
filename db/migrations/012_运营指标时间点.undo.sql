DROP INDEX IF EXISTS tasks_operational_metrics_idx;
ALTER TABLE tasks DROP COLUMN IF EXISTS decision_at;
ALTER TABLE tasks DROP COLUMN IF EXISTS draft_ready_at;
