ALTER TABLE tasks
ADD COLUMN draft_ready_at TIMESTAMPTZ;

ALTER TABLE tasks
ADD COLUMN decision_at TIMESTAMPTZ;

CREATE INDEX tasks_operational_metrics_idx
ON tasks (tenant_id, created_at DESC, draft_ready_at, decision_at);
