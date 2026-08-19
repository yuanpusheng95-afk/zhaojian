ALTER TABLE generation_jobs
  ADD COLUMN provider_name text,
  ADD COLUMN provider_job_id text,
  ADD COLUMN provider_submitted_at timestamptz,
  ADD CONSTRAINT generation_jobs_provider_job_complete CHECK (
    (
      provider_name IS NULL
      AND provider_job_id IS NULL
      AND provider_submitted_at IS NULL
    )
    OR (
      provider_name IS NOT NULL
      AND provider_job_id IS NOT NULL
      AND provider_submitted_at IS NOT NULL
    )
  );

CREATE UNIQUE INDEX generation_jobs_provider_job_unique_idx
  ON generation_jobs(provider_name, provider_job_id)
  WHERE provider_job_id IS NOT NULL;
