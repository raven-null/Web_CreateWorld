-- 新账号写操作限流计数（按用户 + 自然日）
CREATE TABLE write_counters (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
