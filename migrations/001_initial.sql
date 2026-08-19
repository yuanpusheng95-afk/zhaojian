CREATE TABLE assets (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('source', 'generated')),
  uri text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE TABLE projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  active_revision_id text,
  running_generation_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE photo_revisions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  parent_revision_id text REFERENCES photo_revisions(id),
  state_json jsonb NOT NULL,
  anchor_asset_id text REFERENCES assets(id),
  source_generation_id text,
  created_at timestamptz NOT NULL
);

CREATE INDEX photo_revisions_project_created_idx
  ON photo_revisions(project_id, created_at, id);

CREATE TABLE generation_jobs (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  input_revision_id text NOT NULL REFERENCES photo_revisions(id),
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  patch_json jsonb NOT NULL,
  proposed_state_json jsonb NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'queued',
      'preparing',
      'submitted',
      'provider_processing',
      'verifying',
      'completed',
      'partial_failed',
      'failed',
      'cancelled'
    )
  ),
  selected_candidate_id text,
  selected_revision_id text,
  last_error_json jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX generation_jobs_queue_idx
  ON generation_jobs(status, created_at, id);

CREATE INDEX generation_jobs_project_created_idx
  ON generation_jobs(project_id, created_at, id);

CREATE TABLE generation_outputs (
  id text PRIMARY KEY,
  generation_id text NOT NULL REFERENCES generation_jobs(id),
  asset_id text NOT NULL REFERENCES assets(id),
  verification_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  UNIQUE (generation_id, asset_id)
);

CREATE INDEX generation_outputs_generation_idx
  ON generation_outputs(generation_id, created_at, id);

CREATE TABLE idempotency_requests (
  project_id text NOT NULL REFERENCES projects(id),
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  generation_id text NOT NULL REFERENCES generation_jobs(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, idempotency_key)
);

ALTER TABLE projects
  ADD CONSTRAINT projects_active_revision_fk
  FOREIGN KEY (active_revision_id) REFERENCES photo_revisions(id),
  ADD CONSTRAINT projects_running_generation_fk
  FOREIGN KEY (running_generation_id) REFERENCES generation_jobs(id);

ALTER TABLE photo_revisions
  ADD CONSTRAINT photo_revisions_source_generation_fk
  FOREIGN KEY (source_generation_id) REFERENCES generation_jobs(id);

ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_selected_candidate_fk
  FOREIGN KEY (selected_candidate_id) REFERENCES generation_outputs(id),
  ADD CONSTRAINT generation_jobs_selected_revision_fk
  FOREIGN KEY (selected_revision_id) REFERENCES photo_revisions(id);
