/**
 * 球面白板的地图编辑器接口（方案 §12）。
 *
 * ⚠️ 本文件是**主站这个宿主**的 API 实现，不是插件的 API。
 * 插件只认 `MapHostAdapter`；主站把这些接口包装成 `HttpMapHostAdapter` 交给插件即可。
 * 换一个宿主，本文件整体作废，而插件一行不用改 —— 这正是插件化的意义。
 */
import { Hono } from "hono";
import { fail, ok } from "../lib/response";
import { canEdit, canRead, loadWorldAccess } from "../lib/world-access";
import { getUser, requireLogin, type AppVariables } from "../middleware/session";
import type { Env } from "../types";

/** 白板宽度下限与上限（方案 §5.1） */
const BOARD_MIN_WIDTH = 512;
const BOARD_MAX_WIDTH = 16384;
/** 宽度规整粒度：256 的瓦片整除、且保证宽是 2 的倍数（兼容旧标记） */
const BOARD_WIDTH_STEP = 128;
/** 单次保存的瓦片数上限（每个瓦片最大 64KB 索引数据，压缩后更小） */
const MAX_TILES_PER_SAVE = 16;
/** 默认地形调色板（与 packages/map-core 的 DEFAULT_TERRAIN_PALETTE 保持一致） */
const DEFAULT_PALETTE = [
  { index: 1, key: "ocean", name: "海洋", color: "#1d3a4e" },
  { index: 2, key: "shallow", name: "浅海", color: "#2f5a72" },
  { index: 3, key: "grass", name: "草地", color: "#5d7a4a" },
  { index: 4, key: "forest", name: "森林", color: "#3f5c3a" },
  { index: 5, key: "desert", name: "沙漠", color: "#c2a878" },
  { index: 6, key: "mountain", name: "山地", color: "#7b6a58" },
  { index: 7, key: "snow", name: "雪地", color: "#d8dfe3" },
];

interface MapRow {
  id: string;
  world_id: string;
  name: string;
  kind: string;
  board_width: number;
  board_height: number;
  revision: number;
  radius_km: number;
  palette: string | null;
  created_by: string | null;
}

interface LayerRow {
  id: string;
  name: string;
  type: string;
  storage: string;
  visible: number;
  opacity: number;
  z_index: number;
  legend: string | null;
}

const canvasRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * 把用户输入的宽度规整为合法值：向上取整到 128 的倍数并夹在允许范围内。
 * @param raw 用户输入
 * @returns 规整后的宽度；非法输入返回 null
 */
function normalizeWidth(raw: unknown): number | null {
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value)) {
    return null;
  }
  const stepped = Math.ceil(value / BOARD_WIDTH_STEP) * BOARD_WIDTH_STEP;
  const clamped = Math.min(Math.max(stepped, BOARD_MIN_WIDTH), BOARD_MAX_WIDTH);
  return clamped;
}

/**
 * 校验瓦片坐标是否落在白板网格内（列环绕、行不环绕）。
 * @param col 列号
 * @param row 行号
 * @param cols 总列数
 * @param rows 总行数
 * @returns 合法返回 true
 */
function isValidTileCoord(col: number, row: number, cols: number, rows: number): boolean {
  return Number.isInteger(col) && Number.isInteger(row) && row >= 0 && row < rows && cols > 0;
}

/**
 * 读取白板地图并校验查看 / 编辑权限。
 * @param db D1 数据库
 * @param mapId 地图 id
 * @param userId 当前用户 id
 * @returns 地图行、权限与是否可编辑；不存在或不可读返回 null
 */
async function loadCanvasMap(db: D1Database, mapId: string, userId: string | null) {
  const map = await db
    .prepare("SELECT id, world_id, name, kind, board_width, board_height, revision, radius_km, palette, created_by FROM maps WHERE id = ?")
    .bind(mapId)
    .first<MapRow>();
  if (!map) {
    return null;
  }
  const access = await loadWorldAccess(db, map.world_id, userId);
  if (!access) {
    return null;
  }
  return { map, access, canEdit: canEdit(access, userId) };
}

/**
 * 创建白板地图（自动建一个「地形」图层）。
 * body: { name, width, radiusKm? }
 */
canvasRoutes.post("/worlds/:worldId/maps/canvas", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("worldId"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!canEdit(access, user.id)) {
    return fail(c, "没有编辑权限", 403);
  }

  let body: { name?: unknown; width?: unknown; radiusKm?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name) {
    return fail(c, "请填写地图名称");
  }
  const width = normalizeWidth(body.width);
  if (!width) {
    return fail(c, `白板宽度需在 ${BOARD_MIN_WIDTH}~${BOARD_MAX_WIDTH} 之间`);
  }
  const height = width / 2;
  const radiusKm = Number(body.radiusKm);
  const safeRadius = Number.isFinite(radiusKm) && radiusKm > 0 ? radiusKm : 6371;

  const now = Date.now();
  const mapId = crypto.randomUUID();
  const layerId = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO maps
         (id, world_id, name, image_key, kind, projection, board_width, board_height, revision, radius_km, palette, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '', 'canvas', 'equirect', ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).bind(
      mapId,
      access.world.id,
      name,
      width,
      height,
      safeRadius,
      JSON.stringify(DEFAULT_PALETTE),
      user.id,
      now,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO map_layers (id, map_id, name, type, storage, visible, opacity, z_index, legend, created_at, updated_at)
       VALUES (?, ?, '地形', 'terrain', 'raster', 1, 1, 0, NULL, ?, ?)`,
    ).bind(layerId, mapId, now, now),
    c.env.DB.prepare("UPDATE worlds SET updated_at = ? WHERE id = ?").bind(now, access.world.id),
  ]);

  return ok(c, { id: mapId, width, height, terrainLayerId: layerId }, 201);
});

/** 读取白板元信息：白板规格、图层、revision、调色板 */
canvasRoutes.get("/maps/:mapId/canvas", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const loaded = await loadCanvasMap(c.env.DB, c.req.param("mapId"), userId);
  if (!loaded || !canRead(loaded.access)) {
    return fail(c, "地图不存在或无权访问", 404);
  }
  if (loaded.map.kind !== "canvas") {
    return fail(c, "这不是画布型地图", 400);
  }

  const layers = await c.env.DB.prepare(
    "SELECT id, name, type, storage, visible, opacity, z_index, legend FROM map_layers WHERE map_id = ? ORDER BY z_index ASC",
  )
    .bind(loaded.map.id)
    .all<LayerRow>();

  const tiles = await c.env.DB.prepare(
    "SELECT COUNT(*) AS tileCount, COALESCE(SUM(LENGTH(data)), 0) AS tileBytes FROM map_tiles WHERE map_id = ?",
  )
    .bind(loaded.map.id)
    .first<{ tileCount: number; tileBytes: number }>();

  let palette: unknown = DEFAULT_PALETTE;
  if (loaded.map.palette) {
    try {
      palette = JSON.parse(loaded.map.palette);
    } catch {
      palette = DEFAULT_PALETTE;
    }
  }

  return ok(c, {
    id: loaded.map.id,
    worldId: loaded.map.world_id,
    name: loaded.map.name,
    kind: loaded.map.kind,
    canEdit: loaded.canEdit,
    board: {
      width: loaded.map.board_width,
      height: loaded.map.board_height,
      projection: "equirect" as const,
      radiusKm: loaded.map.radius_km,
    },
    revision: loaded.map.revision,
    palette,
    layers: (layers.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      storage: row.storage,
      visible: row.visible === 1,
      opacity: row.opacity,
      zIndex: row.z_index,
      legend: row.legend ? (JSON.parse(row.legend) as unknown[]) : [],
    })),
    tileStats: {
      tileCount: Number(tiles?.tileCount ?? 0),
      tileBytes: Number(tiles?.tileBytes ?? 0),
    },
  });
});

/**
 * 读取瓦片（多段二进制响应）。
 * query: layer, cols=0,1, rows=0,1
 * 响应：`[4B 长度][数据]` 重复，长度 0 表示该瓦片不存在（视为空瓦片）
 */
canvasRoutes.get("/maps/:mapId/tiles", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const loaded = await loadCanvasMap(c.env.DB, c.req.param("mapId"), userId);
  if (!loaded || !canRead(loaded.access)) {
    return fail(c, "地图不存在或无权访问", 404);
  }

  const layerId = c.req.query("layer") ?? "";
  if (!layerId) {
    return fail(c, "缺少图层参数");
  }
  const cols = parseNumberList(c.req.query("cols"));
  const rows = parseNumberList(c.req.query("rows"));
  if (cols.length === 0 || rows.length === 0) {
    return fail(c, "缺少瓦片行列参数");
  }
  if (cols.length * rows.length > 64) {
    return fail(c, "单次最多读取 64 个瓦片");
  }

  const totalCols = Math.ceil(loaded.map.board_width / 256);
  const totalRows = Math.ceil(loaded.map.board_height / 256);
  const coords: { col: number; row: number }[] = [];
  for (const row of rows) {
    for (const col of cols) {
      if (!isValidTileCoord(col, row, totalCols, totalRows)) {
        return fail(c, `瓦片坐标越界：col=${col}, row=${row}`);
      }
      coords.push({ col, row });
    }
  }

  // 一次取出图层内已存在的瓦片（单图层瓦片数有限），在内存里按坐标筛选，
  // 避免依赖 D1 对元组 IN 语法的支持
  const found = await c.env.DB.prepare(
    "SELECT tile_col, tile_row, data FROM map_tiles WHERE map_id = ? AND layer_id = ?",
  )
    .bind(loaded.map.id, layerId)
    .all<{ tile_col: number; tile_row: number; data: ArrayBuffer }>();

  const wanted = new Set(coords.map((coord) => `${coord.col}:${coord.row}`));
  const payloadByKey = new Map<string, Uint8Array>();
  for (const row of found.results ?? []) {
    const key = `${row.tile_col}:${row.tile_row}`;
    if (wanted.has(key)) {
      payloadByKey.set(key, new Uint8Array(row.data));
    }
  }

  let total = 0;
  const segments: Uint8Array[] = [];
  for (const coord of coords) {
    const data = payloadByKey.get(`${coord.col}:${coord.row}`);
    const lengthBytes = new Uint8Array(4);
    new DataView(lengthBytes.buffer).setUint32(0, data?.length ?? 0, true);
    segments.push(lengthBytes);
    if (data) {
      segments.push(data);
      total += data.length;
    }
  }

  const out = new Uint8Array(segments.reduce((sum, segment) => sum + segment.length, 0));
  let offset = 0;
  for (const segment of segments) {
    out.set(segment, offset);
    offset += segment.length;
  }

  return c.body(out, 200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(out.length),
    "X-Tile-Count": String(coords.length),
    "X-Revision": String(loaded.map.revision),
    // 二进制瓦片不参与 HTTP 缓存，避免与 revision 校验打架
    "Cache-Control": "no-store",
    ...(total === 0 ? { "X-Tile-Empty": "1" } : {}),
  });
});

/**
 * 保存脏瓦片（增量）。
 * body: { layerId, revision, tiles: [{ col, row, data: base64 }] }
 * revision 不匹配时返回 409 与当前版本号，由前端决定覆盖或放弃。
 */
canvasRoutes.put("/maps/:mapId/tiles", requireLogin, async (c) => {
  const user = getUser(c);
  const loaded = await loadCanvasMap(c.env.DB, c.req.param("mapId"), user.id);
  if (!loaded) {
    return fail(c, "地图不存在", 404);
  }
  if (!loaded.canEdit) {
    return fail(c, "没有编辑权限", 403);
  }

  let body: { layerId?: unknown; revision?: unknown; tiles?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }

  const layerId = typeof body.layerId === "string" ? body.layerId : "";
  if (!layerId) {
    return fail(c, "缺少图层参数");
  }
  const layer = await c.env.DB.prepare("SELECT id, storage FROM map_layers WHERE id = ? AND map_id = ?")
    .bind(layerId, loaded.map.id)
    .first<{ id: string; storage: string }>();
  if (!layer) {
    return fail(c, "图层不存在");
  }
  if (layer.storage !== "raster") {
    return fail(c, "该图层不是栅格图层，不能保存瓦片");
  }

  const revision = Number(body.revision);
  if (!Number.isInteger(revision)) {
    return fail(c, "缺少版本号");
  }
  if (revision !== loaded.map.revision) {
    return c.json({ ok: false as const, error: "地图已被修改", data: { revision: loaded.map.revision } }, 409);
  }

  if (!Array.isArray(body.tiles) || body.tiles.length === 0) {
    return fail(c, "没有需要保存的瓦片");
  }
  if (body.tiles.length > MAX_TILES_PER_SAVE) {
    return fail(c, `单次最多保存 ${MAX_TILES_PER_SAVE} 个瓦片，请分批提交`);
  }

  const totalCols = Math.ceil(loaded.map.board_width / 256);
  const totalRows = Math.ceil(loaded.map.board_height / 256);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  let emptyCount = 0;

  for (const raw of body.tiles) {
    const tile = raw as { col?: unknown; row?: unknown; data?: unknown };
    const col = Number(tile.col);
    const row = Number(tile.row);
    if (!isValidTileCoord(col, row, totalCols, totalRows)) {
      return fail(c, `瓦片坐标越界：col=${String(tile.col)}, row=${String(tile.row)}`);
    }
    if (typeof tile.data !== "string" || !tile.data) {
      return fail(c, "瓦片数据格式不正确");
    }
    const bytes = base64ToBytes(tile.data);
    if (bytes.length === 0) {
      // 空瓦片：删除行，保持「空瓦片不落库」
      statements.push(
        c.env.DB.prepare("DELETE FROM map_tiles WHERE map_id = ? AND layer_id = ? AND tile_col = ? AND tile_row = ?").bind(
          loaded.map.id,
          layerId,
          col,
          row,
        ),
      );
      emptyCount += 1;
      continue;
    }
    if (bytes.length > 96 * 1024) {
      return fail(c, "单个瓦片数据过大");
    }
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO map_tiles (map_id, layer_id, tile_col, tile_row, format, data, updated_at)
         VALUES (?, ?, ?, ?, 'cwt1', ?, ?)
         ON CONFLICT (map_id, layer_id, tile_col, tile_row) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      ).bind(loaded.map.id, layerId, col, row, bytes, now),
    );
  }

  const nextRevision = loaded.map.revision + 1;
  await c.env.DB.batch([
    ...statements,
    c.env.DB.prepare("UPDATE maps SET revision = ?, updated_at = ? WHERE id = ?").bind(nextRevision, now, loaded.map.id),
  ]);

  return ok(c, { revision: nextRevision, saved: body.tiles.length, empty: emptyCount });
});

/**
 * 解析形如 "0,1,2" 的查询参数为数字数组。
 * @param raw 原始字符串
 * @returns 数字数组；非法项被忽略
 */
function parseNumberList(raw: string | undefined): number[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isInteger(value));
}

/**
 * base64 字符串转字节（Worker 环境没有 Buffer / atob 之外的工具，这里手写解码）。
 * @param base64 base64 文本
 * @returns 字节数组
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export default canvasRoutes;
