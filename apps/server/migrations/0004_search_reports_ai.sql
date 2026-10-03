-- 内容块纯文本（全文搜索用；保存时由服务端从 TipTap JSON 提取）
ALTER TABLE entry_blocks ADD COLUMN text_content TEXT NOT NULL DEFAULT '';

-- 举报
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  world_id TEXT,
  target_type TEXT NOT NULL, -- world / entry / user
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending / resolved / rejected
  action TEXT NOT NULL DEFAULT '',
  handler_id TEXT,
  handled_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reports_status ON reports (status, created_at DESC);

-- 用户 AI 配置（API Key 加密存储）
CREATE TABLE user_ai_settings (
  user_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'custom',
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- AI 调用记录
CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  world_id TEXT,
  kind TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
