DROP INDEX capability_budget_usage_project_idx;
DROP TABLE capability_budget_usage;
ALTER TABLE work_plans DROP COLUMN capability_budget_ciphertext;
ALTER TABLE work_plans DROP COLUMN authorization_hash;
