CREATE TABLE decision_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  expected_should_reply BOOLEAN NOT NULL,
  reviewer TEXT NOT NULL,
  note_ciphertext TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, task_id),
  CONSTRAINT decision_reviews_task_fkey
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX decision_reviews_updated_idx
ON decision_reviews (tenant_id, updated_at DESC);
