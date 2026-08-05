DROP INDEX tasks_awaiting_approval_idx;

UPDATE tasks
SET status = 'no_reply', updated_at = now()
WHERE status = 'expired';

ALTER TABLE tasks
DROP CONSTRAINT tasks_status_check;

ALTER TABLE tasks
ADD CONSTRAINT tasks_status_check CHECK (
  status IN (
    'queued', 'processing', 'awaiting_approval', 'no_reply',
    'approved', 'rejected', 'sending', 'completed',
    'send_unknown', 'cancelled_manual', 'dead'
  )
);
