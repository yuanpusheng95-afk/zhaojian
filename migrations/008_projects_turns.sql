ALTER TABLE projects DROP CONSTRAINT projects_running_generation_fk;
ALTER TABLE projects DROP COLUMN running_generation_id;
ALTER TABLE projects ADD COLUMN running_turn_id text REFERENCES agent_turns(id);
ALTER TABLE projects ADD COLUMN owner_id text NOT NULL DEFAULT 'dev';
