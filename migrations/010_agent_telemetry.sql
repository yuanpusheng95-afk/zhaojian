-- Telemetry span 的持久层。与 session(对话事实)、agent_turns(轮次摘要)分离:
-- 保留策略独立(度量数据可短周期清理,不影响轨迹审计)、查询模式独立
-- (成本统计走 SUM/GROUP BY,不挖 session 的 jsonb)、物理上不可能污染 LLM 上下文。
CREATE TABLE agent_telemetry_spans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  turn_id text REFERENCES agent_turns(id) ON DELETE SET NULL,
  project_id text,
  name text NOT NULL,
  duration_ms integer NOT NULL,
  status text NOT NULL DEFAULT 'ok',
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 按 name+时间聚合(成本/延迟报表),按轮次回查(排障入口)
CREATE INDEX agent_telemetry_spans_name_created_idx ON agent_telemetry_spans(name, created_at);
CREATE INDEX agent_telemetry_spans_turn_idx ON agent_telemetry_spans(turn_id);
