-- Turn 详情、worker outcome 统计与 SSE 指纹都按 turn 读取 generations。
-- turn_id 放前导:详情/统计两列等值查询不受列序影响,而 SSE 指纹的
-- LEFT JOIN 只按 turn_id 关联(无 project 前缀可用)——project 前导会让它
-- 每次轮询退化成全表扫描。
CREATE INDEX generations_turn_project_created_idx
  ON generations(turn_id, project_id, created_at, id);
