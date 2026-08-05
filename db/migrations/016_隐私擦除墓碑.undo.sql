DROP INDEX IF EXISTS work_plans_privacy_active_idx;
DROP INDEX IF EXISTS tasks_privacy_active_idx;
DROP TABLE IF EXISTS privacy_erased_messages;

ALTER TABLE work_plans DROP COLUMN IF EXISTS privacy_erased_at;
ALTER TABLE tasks DROP COLUMN IF EXISTS privacy_erased_at;
