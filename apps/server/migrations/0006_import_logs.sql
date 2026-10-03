-- 导入记录（频次限额与审计）
CREATE TABLE import_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  world_id TEXT,
  entries_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing', -- processing / success / failed
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_import_logs_user ON import_logs (user_id, created_at DESC);
