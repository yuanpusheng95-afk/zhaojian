CREATE TABLE agent_sessions (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  parent_session_id text REFERENCES agent_sessions(id),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX agent_sessions_created_idx ON agent_sessions(created_at DESC, id);

CREATE TABLE agent_session_sequences (
  session_id text PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  next_seq bigint NOT NULL DEFAULT 1
);

-- entries 与 records 共享同一个 id 命名空间：同一会话内 id 全局唯一。
-- PostgreSQL 无法跨表建唯一索引，因此用一张注册表承载该约束。
CREATE TABLE agent_session_ids (
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('entry', 'record')),
  PRIMARY KEY (session_id, id)
);

CREATE TABLE agent_session_entries (
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  id text NOT NULL,
  seq bigint NOT NULL,
  parent_id text,
  type text NOT NULL,
  custom_type text,
  timestamp_ms bigint NOT NULL,
  payload_json jsonb NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);

CREATE INDEX agent_session_entries_parent_idx
  ON agent_session_entries(session_id, parent_id);
CREATE INDEX agent_session_entries_type_seq_idx
  ON agent_session_entries(session_id, type, seq);

CREATE TABLE agent_session_lanes (
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  lane text NOT NULL,
  leaf_id text,
  PRIMARY KEY (session_id, lane)
);

CREATE TABLE agent_session_lane_moves (
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  lane text NOT NULL,
  leaf_id text,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE agent_session_records (
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  id text NOT NULL,
  seq bigint NOT NULL,
  lane text NOT NULL,
  run_id text,
  type text NOT NULL,
  op_kind text,
  timestamp_ms bigint NOT NULL,
  payload_json jsonb NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);

CREATE INDEX agent_session_records_lane_seq_idx
  ON agent_session_records(session_id, lane, seq);
CREATE INDEX agent_session_records_type_seq_idx
  ON agent_session_records(session_id, type, seq);
CREATE INDEX agent_session_records_run_idx
  ON agent_session_records(session_id, run_id, seq);

CREATE TABLE agent_session_facts (
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  kind text NOT NULL,
  key text,
  value text,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX agent_session_facts_kind_key_seq_idx
  ON agent_session_facts(session_id, kind, key, seq DESC);
