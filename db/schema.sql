CREATE TABLE IF NOT EXISTS foursday_memory_candidates (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('atom', 'prospective', 'source')),
  fact_key TEXT NOT NULL,
  title_ciphertext TEXT NOT NULL,
  statement_ciphertext TEXT NOT NULL,
  evidence_ciphertext TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'internal')),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0.97 AND confidence <= 1),
  source_session_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN (
      'proposed', 'processing', 'retry', 'promoted', 'blocked',
      'retirement_pending', 'retiring', 'revoked'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  authority_slug TEXT,
  authority_commit TEXT,
  authority_sha256 TEXT,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at TIMESTAMPTZ,
  privacy_erased_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, candidate_key)
);

CREATE TABLE IF NOT EXISTS foursday_memory_candidate_sources (
  tenant_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  source_principal_key TEXT NOT NULL,
  source_session_hash TEXT NOT NULL CHECK (source_session_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, candidate_id, source_principal_key, source_session_hash),
  FOREIGN KEY (tenant_id, candidate_id)
    REFERENCES foursday_memory_candidates(tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS foursday_memory_candidates_queue_idx
ON foursday_memory_candidates (tenant_id, status, updated_at)
WHERE status IN ('proposed', 'retry', 'processing');

CREATE INDEX IF NOT EXISTS foursday_memory_candidates_project_idx
ON foursday_memory_candidates (tenant_id, project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS foursday_memory_candidates_principal_idx
ON foursday_memory_candidate_sources (tenant_id, source_principal_key, created_at DESC);
