-- 地图编辑器（球面白板）：白板元信息、图层、瓦片、矢量对象
-- 设计见 docs/地图编辑器方案.md §6.2
--
-- 注意：本迁移只新增列与表，不改动既有列语义；
-- markers.x / y 仍是 0~1 相对比例，含义升级为「平面归一化坐标」，旧数据无需迁移。

-- ① 地图：补充白板与投影信息（原字段保持不变）
ALTER TABLE maps ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';            -- image | canvas
ALTER TABLE maps ADD COLUMN projection TEXT NOT NULL DEFAULT 'equirect';   -- 等距圆柱
ALTER TABLE maps ADD COLUMN board_width INTEGER NOT NULL DEFAULT 0;        -- 白板宽（512~16384，128 的倍数）
ALTER TABLE maps ADD COLUMN board_height INTEGER NOT NULL DEFAULT 0;       -- 白板高 = board_width / 2
ALTER TABLE maps ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;           -- 每次保存 +1，冲突检测
ALTER TABLE maps ADD COLUMN palette TEXT;                                  -- JSON：地形调色板
ALTER TABLE maps ADD COLUMN radius_km REAL NOT NULL DEFAULT 6371;          -- 天体半径，比例尺的唯一参数
ALTER TABLE maps ADD COLUMN stats TEXT;                                    -- JSON：各图层已画像素数
ALTER TABLE maps ADD COLUMN scale_hints TEXT;                              -- JSON：尺度提示配置

-- ② 图层：用户可自由增删（图层是数据不是代码）
CREATE TABLE map_layers (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL,
  name TEXT NOT NULL,                 -- 政治 / 军事 / 宗教 / 民族 …
  type TEXT NOT NULL,                 -- terrain | political | military | religion | ethnic | labels | custom
  storage TEXT NOT NULL,              -- raster | vector
  visible INTEGER NOT NULL DEFAULT 1,
  opacity REAL NOT NULL DEFAULT 1,
  z_index INTEGER NOT NULL DEFAULT 0, -- 渲染顺序，越大越上层
  legend TEXT,                        -- JSON：图例项（名称 + 颜色）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_map_layers_map ON map_layers (map_id, z_index);

-- ③ 栅格瓦片（仅 raster 图层）：256×256 经纬网分块
--    列环绕、行不环绕；空瓦片不落库（缺失即视为空）
CREATE TABLE map_tiles (
  map_id TEXT NOT NULL,
  layer_id TEXT NOT NULL,
  tile_col INTEGER NOT NULL,
  tile_row INTEGER NOT NULL,
  format TEXT NOT NULL,               -- cwt1 = 调色板索引 + 可选 gzip
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (map_id, layer_id, tile_col, tile_row)
);

-- ④ 矢量对象（vector 图层）：几何与样式存 JSON，坐标是经纬度
CREATE TABLE map_features (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL,
  layer_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- area | border | route | arrow | symbol | text
  geometry TEXT NOT NULL,             -- JSON：经纬度点列
  style TEXT,                         -- JSON：颜色 / 线宽 / 字体等
  label TEXT NOT NULL DEFAULT '',
  link_ref TEXT,                      -- 宿主侧关联标识（主站放条目 id）
  bbox_min_lon REAL,
  bbox_max_lon REAL,
  bbox_min_lat REAL,
  bbox_max_lat REAL,
  z_index INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_map_features_layer ON map_features (map_id, layer_id, z_index);
CREATE INDEX idx_map_features_bbox ON map_features (map_id, bbox_min_lon, bbox_max_lon);

-- ⑤ 标记：追加归属图层与显示缩放（列语义不变）
ALTER TABLE markers ADD COLUMN layer_id TEXT;
ALTER TABLE markers ADD COLUMN size REAL DEFAULT 1;
CREATE INDEX idx_markers_entry ON markers (entry_id);
