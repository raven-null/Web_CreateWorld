-- 时间系统：世界级时间配置
ALTER TABLE worlds ADD COLUMN time_granularity TEXT NOT NULL DEFAULT 'day'; -- year / month / day
ALTER TABLE worlds ADD COLUMN time_number_style TEXT NOT NULL DEFAULT 'arabic'; -- arabic / chinese

-- 纪元
CREATE TABLE eras (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_eras_world ON eras (world_id, sort_order);

-- 时间线事件
CREATE TABLE timeline_events (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  era_id TEXT,
  year INTEGER,
  month INTEGER,
  day INTEGER,
  season TEXT NOT NULL DEFAULT '',
  time_undetermined INTEGER NOT NULL DEFAULT 0,
  entry_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_timeline_events_world ON timeline_events (world_id, era_id, year);
