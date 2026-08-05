CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (
    type IN ('working', 'project', 'person', 'principle', 'knowledge')
  ),
  subject_key TEXT NOT NULL,
  subject_ciphertext TEXT NOT NULL,
  project_id TEXT,
  statement_ciphertext TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id_ciphertext TEXT NOT NULL,
  source_version TEXT,
  scope_ciphertext TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (
    confidence >= 0 AND confidence <= 1
  ),
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'confirmed', 'rejected', 'revoked')
  ),
  sensitivity TEXT NOT NULL CHECK (
    sensitivity IN ('public', 'internal', 'confidential')
  ),
  valid_from TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  supersedes_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT memory_items_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT memory_items_supersedes_fkey
    FOREIGN KEY (tenant_id, supersedes_id)
    REFERENCES memory_items (tenant_id, id)
    ON DELETE SET NULL (supersedes_id)
);

CREATE INDEX memory_items_active_idx
ON memory_items (tenant_id, project_id, type, subject_key, updated_at DESC)
WHERE status = 'confirmed' AND deleted_at IS NULL;

CREATE INDEX memory_items_review_idx
ON memory_items (tenant_id, created_at DESC)
WHERE status = 'proposed' AND deleted_at IS NULL;
