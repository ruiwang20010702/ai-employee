ALTER TABLE tasks
ADD CONSTRAINT tasks_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE messages
DROP CONSTRAINT messages_task_id_fkey,
ADD CONSTRAINT messages_tenant_task_fkey
  FOREIGN KEY (tenant_id, task_id)
  REFERENCES tasks (tenant_id, id)
  ON DELETE SET NULL (task_id);

ALTER TABLE approvals
DROP CONSTRAINT approvals_task_id_fkey,
ADD CONSTRAINT approvals_tenant_task_fkey
  FOREIGN KEY (tenant_id, task_id)
  REFERENCES tasks (tenant_id, id)
  ON DELETE CASCADE;

ALTER TABLE side_effects
DROP CONSTRAINT side_effects_task_id_fkey,
ADD CONSTRAINT side_effects_tenant_task_fkey
  FOREIGN KEY (tenant_id, task_id)
  REFERENCES tasks (tenant_id, id)
  ON DELETE CASCADE;

ALTER TABLE audit_events
DROP CONSTRAINT audit_events_task_id_fkey,
ADD CONSTRAINT audit_events_tenant_task_fkey
  FOREIGN KEY (tenant_id, task_id)
  REFERENCES tasks (tenant_id, id)
  ON DELETE SET NULL (task_id);
