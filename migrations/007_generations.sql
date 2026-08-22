ALTER TABLE generation_jobs RENAME TO generations;

ALTER TABLE generations
  ADD COLUMN input_asset_id text NOT NULL REFERENCES assets(id),
  ADD COLUMN turn_id text NOT NULL REFERENCES agent_turns(id),
  ADD COLUMN metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE generations
  DROP COLUMN idempotency_key,
  DROP COLUMN operation,
  DROP COLUMN claim_token,
  DROP COLUMN claimed_at,
  DROP COLUMN lease_expires_at,
  DROP COLUMN attempt_count,
  DROP COLUMN provider_name,
  DROP COLUMN provider_model,
  DROP COLUMN provider_job_id,
  DROP COLUMN provider_submitted_at;

ALTER TABLE generations DROP CONSTRAINT generation_jobs_status_check;
DROP INDEX generation_jobs_queue_idx;

ALTER TABLE generations
  ADD CONSTRAINT generations_status_check CHECK (status IN ('completed','failed'));

ALTER TABLE generations RENAME CONSTRAINT generation_jobs_pkey TO generations_pkey;
ALTER TABLE generations RENAME CONSTRAINT generation_jobs_project_id_fkey TO generations_project_id_fkey;
ALTER TABLE generations RENAME CONSTRAINT generation_jobs_input_revision_id_fkey TO generations_input_revision_id_fkey;
ALTER TABLE generations RENAME CONSTRAINT generation_jobs_selected_candidate_fk TO generations_selected_candidate_fk;
ALTER TABLE generations RENAME CONSTRAINT generation_jobs_selected_revision_fk TO generations_selected_revision_fk;
ALTER INDEX generation_jobs_project_created_idx RENAME TO generations_project_created_idx;
