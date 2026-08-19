ALTER TABLE generation_jobs
  ADD COLUMN claim_token text,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0);

CREATE INDEX generation_jobs_active_lease_idx
  ON generation_jobs(lease_expires_at, created_at, id)
  WHERE status IN (
    'preparing',
    'submitted',
    'provider_processing',
    'verifying'
  );
