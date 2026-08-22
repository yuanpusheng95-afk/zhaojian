CREATE TABLE agent_turns (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  user_message text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','aborted')),
  lease_token text,
  lease_expires_at timestamptz,
  outcome_json jsonb,
  error_json jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX agent_turns_queue_idx ON agent_turns(status, created_at, id);
CREATE INDEX agent_turns_project_created_idx ON agent_turns(project_id, created_at, id);
