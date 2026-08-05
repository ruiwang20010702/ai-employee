DROP INDEX IF EXISTS memory_items_source_access_idx;
ALTER TABLE memory_items
  DROP CONSTRAINT IF EXISTS memory_items_source_access_status_check,
  DROP COLUMN IF EXISTS source_access_expires_at,
  DROP COLUMN IF EXISTS source_access_checked_at,
  DROP COLUMN IF EXISTS source_access_reason,
  DROP COLUMN IF EXISTS source_access_status;
