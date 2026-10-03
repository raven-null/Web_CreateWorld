-- 世界观协作平台：初始表结构（MVP）
-- 说明：better-auth 的 user/session/account/verification 表由程序化迁移创建，不在此文件

-- 世界
CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  cover TEXT,
  visibility TEXT NOT NULL DEFAULT 'private', -- private / public_read / public_edit
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_worlds_visibility ON worlds (visibility, updated_at DESC);

-- 世界成员
CREATE TABLE world_members (
  world_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL, -- owner / admin / editor / viewer
  source TEXT NOT NULL DEFAULT 'invite', -- invite / open
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, user_id)
);
CREATE INDEX idx_world_members_user ON world_members (user_id);

-- 邀请码（平台注册码 / 世界邀请码）
CREATE TABLE invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL, -- platform / world
  world_id TEXT,
  role TEXT,
  created_by TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active', -- active / disabled
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_invite_codes_code ON invite_codes (code);

-- 世界内自定义分类
CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_categories_world ON categories (world_id, sort_order);

-- 平台世界标签库
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' -- active / disabled
);

-- 世界与标签的关联
CREATE TABLE world_tags (
  world_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (world_id, tag_id)
);

-- 条目（正文内容按块存于 entry_blocks）
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cover TEXT,
  tags TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '',
  protected INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  last_editor_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_entries_world ON entries (world_id, category_id, updated_at DESC);
CREATE INDEX idx_entries_title ON entries (world_id, title);

-- 条目内容块
CREATE TABLE entry_blocks (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_entry_blocks_entry ON entry_blocks (entry_id, sort_order);

-- 条目间的双向链接
CREATE TABLE entry_links (
  id TEXT PRIMARY KEY,
  from_entry_id TEXT NOT NULL,
  to_entry_id TEXT, -- 已解析的目标；为空表示断链
  to_title TEXT NOT NULL, -- 链接文本（用于断链回填）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_entry_links_from ON entry_links (from_entry_id);
CREATE INDEX idx_entry_links_to ON entry_links (to_entry_id);

-- 条目版本记录（按块增量快照）
CREATE TABLE entry_versions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  changed_blocks TEXT NOT NULL DEFAULT '[]', -- JSON：变更块快照列表
  editor_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_entry_versions_entry ON entry_versions (entry_id, version DESC);

-- 世界黑名单
CREATE TABLE world_bans (
  world_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  operator_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, user_id)
);

-- 站点管理员操作日志
CREATE TABLE admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- 预设世界标签
INSERT INTO tags (id, name, sort_order) VALUES
  ('tag_fantasy', '奇幻', 1),
  ('tag_scifi', '科幻', 2),
  ('tag_wuxia', '武侠', 3),
  ('tag_urban', '都市', 4),
  ('tag_history', '历史', 5),
  ('tag_alt', '架空', 6),
  ('tag_trpg', '跑团设定', 7),
  ('tag_novel', '小说企划', 8);
