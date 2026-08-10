ALTER TABLE tasks
ADD COLUMN continuation_of_task_id TEXT;

ALTER TABLE tasks
ADD COLUMN waiting_information_at TIMESTAMPTZ;

ALTER TABLE tasks
ADD CONSTRAINT tasks_continuation_task_fk
FOREIGN KEY (tenant_id, continuation_of_task_id)
REFERENCES tasks(tenant_id, id)
ON DELETE SET NULL (continuation_of_task_id);

ALTER TABLE tasks
DROP CONSTRAINT tasks_status_check;

ALTER TABLE tasks
ADD CONSTRAINT tasks_status_check CHECK (
  status IN (
    'queued', 'processing', 'awaiting_approval', 'no_reply',
    'approved', 'rejected', 'sending', 'completed',
    'send_unknown', 'cancelled_manual', 'cancelled_operator', 'expired', 'dead',
    'waiting_information', 'continuation_pending', 'continued'
  )
);

CREATE INDEX tasks_waiting_information_idx
ON tasks (tenant_id, conversation_key, sender_key, waiting_information_at DESC)
WHERE status = 'waiting_information';

CREATE INDEX tasks_continuation_of_idx
ON tasks (tenant_id, continuation_of_task_id)
WHERE continuation_of_task_id IS NOT NULL;
