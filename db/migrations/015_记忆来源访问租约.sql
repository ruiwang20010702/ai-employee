ALTER TABLE memory_items
  ADD COLUMN source_access_status TEXT NOT NULL DEFAULT 'not_required',
  ADD COLUMN source_access_reason TEXT,
  ADD COLUMN source_access_checked_at TIMESTAMPTZ,
  ADD COLUMN source_access_expires_at TIMESTAMPTZ;

UPDATE memory_items
SET source_access_status = 'unverified',
    source_access_reason = 'migration_requires_recheck'
WHERE source_type = 'gbrain' AND deleted_at IS NULL;

ALTER TABLE memory_items
  ADD CONSTRAINT memory_items_source_access_status_check CHECK (
    source_access_status IN (
      'not_required', 'unverified', 'verified', 'unavailable', 'revoked'
    )
  );

CREATE INDEX memory_items_source_access_idx
ON memory_items (tenant_id, source_type, source_access_status, source_access_expires_at)
WHERE deleted_at IS NULL;
