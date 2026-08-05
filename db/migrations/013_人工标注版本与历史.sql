ALTER TABLE decision_reviews
ADD COLUMN decision_sha256 TEXT;

CREATE TABLE decision_review_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  expected_should_reply BOOLEAN NOT NULL,
  reviewer TEXT NOT NULL,
  note_ciphertext TEXT NOT NULL,
  decision_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decision_review_events_task_fkey
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX decision_review_events_task_idx
ON decision_review_events (tenant_id, task_id, created_at DESC);
