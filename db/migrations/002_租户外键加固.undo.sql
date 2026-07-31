ALTER TABLE messages
DROP CONSTRAINT messages_tenant_task_fkey,
ADD CONSTRAINT messages_task_id_fkey
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;

ALTER TABLE approvals
DROP CONSTRAINT approvals_tenant_task_fkey,
ADD CONSTRAINT approvals_task_id_fkey
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;

ALTER TABLE side_effects
DROP CONSTRAINT side_effects_tenant_task_fkey,
ADD CONSTRAINT side_effects_task_id_fkey
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;

ALTER TABLE audit_events
DROP CONSTRAINT audit_events_tenant_task_fkey,
ADD CONSTRAINT audit_events_task_id_fkey
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;

ALTER TABLE tasks DROP CONSTRAINT tasks_tenant_id_unique;
