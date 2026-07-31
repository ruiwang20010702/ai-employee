CREATE TABLE settings (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reply')),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'processing', 'awaiting_approval', 'no_reply',
      'approved', 'rejected', 'sending', 'completed',
      'send_unknown', 'cancelled_manual', 'dead'
    )
  ),
  sender_key TEXT NOT NULL,
  sender_user_id_ciphertext TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  conversation_id_ciphertext TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  result_ciphertext TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ,
  last_error_ciphertext TEXT,
  approval_version INTEGER NOT NULL DEFAULT 1 CHECK (approval_version > 0),
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tasks_tenant_created_idx
ON tasks (tenant_id, created_at DESC);

CREATE INDEX tasks_claimable_idx
ON tasks (tenant_id, available_at, created_at)
WHERE status IN ('queued', 'processing');

CREATE INDEX tasks_approved_idx
ON tasks (tenant_id, approved_at)
WHERE status IN ('approved', 'sending');

CREATE TABLE messages (
  tenant_id TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,
  sender_key TEXT NOT NULL,
  sender_user_id_ciphertext TEXT NOT NULL,
  sender_name_ciphertext TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  conversation_id_ciphertext TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  content_ciphertext TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'bundled')),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, platform_message_id)
);

CREATE INDEX messages_task_id_idx ON messages (task_id);

CREATE INDEX messages_pending_idx
ON messages (tenant_id, conversation_key, sender_key, ingested_at)
WHERE status = 'pending';

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  approval_version INTEGER NOT NULL CHECK (approval_version > 0),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor TEXT NOT NULL,
  reason_ciphertext TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, approval_version)
);

CREATE INDEX approvals_tenant_created_idx
ON approvals (tenant_id, created_at DESC);

CREATE TABLE side_effects (
  idempotency_key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN ('send_message')),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'unknown')),
  receipt_ciphertext TEXT,
  last_error_ciphertext TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX side_effects_task_id_idx ON side_effects (task_id);

CREATE TABLE checkpoints (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  details_ciphertext TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_tenant_time_idx
ON audit_events (tenant_id, occurred_at DESC);

CREATE INDEX audit_events_task_id_idx ON audit_events (task_id);
