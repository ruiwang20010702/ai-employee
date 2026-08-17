CREATE TABLE memory_authority_cleanup_jobs (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  slug_ciphertext TEXT NOT NULL,
  authority_source_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  reason TEXT NOT NULL CHECK (reason IN ('revoked', 'superseded', 'deleted', 'privacy_erased')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, memory_id)
);

CREATE INDEX memory_authority_cleanup_claim_idx
ON memory_authority_cleanup_jobs (tenant_id, status, lease_expires_at, created_at)
WHERE status IN ('pending', 'processing', 'failed');
