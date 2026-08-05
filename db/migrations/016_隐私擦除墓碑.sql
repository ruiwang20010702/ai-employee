ALTER TABLE tasks
  ADD COLUMN privacy_erased_at TIMESTAMPTZ;

ALTER TABLE work_plans
  ADD COLUMN privacy_erased_at TIMESTAMPTZ;

CREATE TABLE privacy_erased_messages (
  tenant_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  erased_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, message_key)
);

CREATE INDEX tasks_privacy_active_idx
ON tasks (tenant_id, sender_key, updated_at)
WHERE privacy_erased_at IS NULL;

CREATE INDEX work_plans_privacy_active_idx
ON work_plans (tenant_id, project_id, requester_key, updated_at)
WHERE privacy_erased_at IS NULL;
