DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tasks
    WHERE status IN ('waiting_information', 'continuation_pending', 'continued')
  ) THEN
    RAISE EXCEPTION 'Cannot remove waiting-information migration while continuation tasks exist';
  END IF;
END
$$;

DROP INDEX tasks_continuation_of_idx;
DROP INDEX tasks_waiting_information_idx;

ALTER TABLE tasks
DROP CONSTRAINT tasks_continuation_task_fk;

ALTER TABLE tasks
DROP COLUMN continuation_of_task_id;

ALTER TABLE tasks
DROP COLUMN waiting_information_at;

ALTER TABLE tasks
DROP CONSTRAINT tasks_status_check;

ALTER TABLE tasks
ADD CONSTRAINT tasks_status_check CHECK (
  status IN (
    'queued', 'processing', 'awaiting_approval', 'no_reply',
    'approved', 'rejected', 'sending', 'completed',
    'send_unknown', 'cancelled_manual', 'cancelled_operator', 'expired', 'dead'
  )
);
