CREATE TABLE availability_samples (
  tenant_id TEXT NOT NULL,
  bucket_at TIMESTAMPTZ NOT NULL,
  ready BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, bucket_at)
);

CREATE INDEX availability_samples_window_idx
ON availability_samples (tenant_id, bucket_at DESC);
