CREATE TABLE api_keys (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  key_hash text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id, created_at);
