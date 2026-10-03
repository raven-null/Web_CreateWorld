-- 地图
CREATE TABLE maps (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  name TEXT NOT NULL,
  image_key TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_maps_world ON maps (world_id, created_at);

-- 地图标记（x / y 为相对图片宽高的比例，0~1，原点左上）
CREATE TABLE markers (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  entry_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_markers_map ON markers (map_id);

-- 草稿箱（碎片想法，可转正式条目）
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  world_id TEXT,
  content TEXT NOT NULL,
  converted_entry_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_drafts_user ON drafts (user_id, updated_at DESC);
