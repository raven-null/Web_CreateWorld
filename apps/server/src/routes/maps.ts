import { Hono } from "hono";
import { fail, ok } from "../lib/response";
import { canEdit, canRead, loadWorldAccess } from "../lib/world-access";
import { getUser, requireLogin, type AppVariables } from "../middleware/session";
import type { Env } from "../types";

/** maps 表数据行 */
interface MapRow {
  id: string;
  world_id: string;
  name: string;
  image_key: string;
  created_at: number;
  updated_at: number;
}

/** markers 表数据行 */
interface MarkerRow {
  id: string;
  map_id: string;
  x: number;
  y: number;
  label: string;
  entry_id: string | null;
  created_at: number;
}

const mapRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * 加载地图并校验编辑权限。
 * @returns 地图行与访问结果；地图不存在返回 null
 */
async function loadMapWithAccess(db: D1Database, mapId: string, userId: string | null) {
  const map = await db.prepare("SELECT * FROM maps WHERE id = ?").bind(mapId).first<MapRow>();
  if (!map) {
    return null;
  }
  const access = await loadWorldAccess(db, map.world_id, userId);
  if (!access) {
    return null;
  }
  return { map, access };
}

/** 世界地图列表（需要查看权限） */
mapRoutes.get("/worlds/:worldId/maps", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const access = await loadWorldAccess(c.env.DB, c.req.param("worldId"), userId);
  if (!access || !canRead(access)) {
    return fail(c, "世界不存在或无权访问", 404);
  }

  const result = await c.env.DB.prepare(
    `SELECT m.id, m.name, m.image_key, m.kind, m.created_at,
            (SELECT COUNT(*) FROM markers k WHERE k.map_id = m.id) AS markerCount
     FROM maps m
     WHERE m.world_id = ?
     ORDER BY m.created_at ASC`,
  )
    .bind(access.world.id)
    .all<Record<string, unknown>>();

  return ok(
    c,
    (result.results ?? []).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      // kind 用于前端区分「画布型（可进编辑器）」与「图片型（沿用 Leaflet 页面）」
      kind: (row.kind as string | null) ?? "image",
      imageUrl: row.image_key ? `/api/images/${row.image_key as string}` : "",
      markerCount: Number(row.markerCount ?? 0),
      createdAt: row.created_at as number,
    })),
  );
});

/** 创建地图 body: { name, imageKey }（需要编辑权限） */
mapRoutes.post("/worlds/:worldId/maps", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("worldId"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!canEdit(access, user.id)) {
    return fail(c, "没有编辑权限", 403);
  }

  let body: { name?: unknown; imageKey?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  const imageKey = typeof body.imageKey === "string" ? body.imageKey.slice(0, 200) : "";
  if (!name || !imageKey) {
    return fail(c, "请填写地图名称并上传图片");
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO maps (id, world_id, name, image_key, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, access.world.id, name, imageKey, user.id, now, now),
    c.env.DB.prepare("UPDATE worlds SET updated_at = ? WHERE id = ?").bind(now, access.world.id),
  ]);
  return ok(c, { id }, 201);
});

/** 地图详情：地图 + 标记（带关联条目标题） */
mapRoutes.get("/maps/:mapId", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const loaded = await loadMapWithAccess(c.env.DB, c.req.param("mapId"), userId);
  if (!loaded || !canRead(loaded.access)) {
    return fail(c, "地图不存在或无权访问", 404);
  }

  const markerResult = await c.env.DB.prepare(
    `SELECT k.id, k.x, k.y, k.label, k.entry_id, e.title AS entryTitle
     FROM markers k
     LEFT JOIN entries e ON e.id = k.entry_id
     WHERE k.map_id = ?
     ORDER BY k.created_at ASC`,
  )
    .bind(loaded.map.id)
    .all<Record<string, unknown>>();

  return ok(c, {
    id: loaded.map.id,
    worldId: loaded.map.world_id,
    name: loaded.map.name,
    imageUrl: `/api/images/${loaded.map.image_key}`,
    canEdit: canEdit(loaded.access, userId),
    markers: (markerResult.results ?? []).map((row) => ({
      id: row.id as string,
      x: row.x as number,
      y: row.y as number,
      label: row.label as string,
      entryId: (row.entry_id as string | null) ?? null,
      entryTitle: (row.entryTitle as string | null) ?? null,
    })),
  });
});

/** 重命名地图 PATCH /maps/:mapId { name } */
mapRoutes.patch("/maps/:mapId", requireLogin, async (c) => {
  const user = getUser(c);
  const loaded = await loadMapWithAccess(c.env.DB, c.req.param("mapId"), user.id);
  if (!loaded) {
    return fail(c, "地图不存在", 404);
  }
  if (!canEdit(loaded.access, user.id)) {
    return fail(c, "没有编辑权限", 403);
  }

  let body: { name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name) {
    return fail(c, "请填写地图名称");
  }

  await c.env.DB.prepare("UPDATE maps SET name = ?, updated_at = ? WHERE id = ?")
    .bind(name, Date.now(), loaded.map.id)
    .run();
  return ok(c, { updated: true });
});

/** 删除地图（含全部标记） */
mapRoutes.delete("/maps/:mapId", requireLogin, async (c) => {
  const user = getUser(c);
  const loaded = await loadMapWithAccess(c.env.DB, c.req.param("mapId"), user.id);
  if (!loaded) {
    return fail(c, "地图不存在", 404);
  }
  if (!canEdit(loaded.access, user.id)) {
    return fail(c, "没有编辑权限", 403);
  }

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM markers WHERE map_id = ?").bind(loaded.map.id),
    c.env.DB.prepare("DELETE FROM maps WHERE id = ?").bind(loaded.map.id),
  ]);
  return ok(c, { deleted: true });
});

/**
 * 添加标记（需要编辑权限）。
 * body: { x, y, label?, entryId? }；x / y 为 0~1 的相对坐标。
 */
mapRoutes.post("/maps/:mapId/markers", requireLogin, async (c) => {
  const user = getUser(c);
  const loaded = await loadMapWithAccess(c.env.DB, c.req.param("mapId"), user.id);
  if (!loaded) {
    return fail(c, "地图不存在", 404);
  }
  if (!canEdit(loaded.access, user.id)) {
    return fail(c, "没有编辑权限", 403);
  }

  let body: { x?: unknown; y?: unknown; label?: unknown; entryId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const x = Number(body.x);
  const y = Number(body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    return fail(c, "标记坐标不正确");
  }
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";

  let entryId: string | null = null;
  if (typeof body.entryId === "string" && body.entryId) {
    const entry = await c.env.DB.prepare("SELECT id FROM entries WHERE id = ? AND world_id = ?")
      .bind(body.entryId, loaded.map.world_id)
      .first();
    if (!entry) {
      return fail(c, "关联条目不存在");
    }
    entryId = body.entryId;
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO markers (id, map_id, x, y, label, entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, loaded.map.id, x, y, label, entryId, Date.now())
    .run();
  return ok(c, { id }, 201);
});

/** 更新标记 PATCH /markers/:markerId { label?, entryId?, x?, y? } */
mapRoutes.patch("/markers/:markerId", requireLogin, async (c) => {
  const user = getUser(c);
  const marker = await c.env.DB.prepare("SELECT * FROM markers WHERE id = ?")
    .bind(c.req.param("markerId"))
    .first<MarkerRow>();
  if (!marker) {
    return fail(c, "标记不存在", 404);
  }
  const loaded = await loadMapWithAccess(c.env.DB, marker.map_id, user.id);
  if (!loaded || !canEdit(loaded.access, user.id)) {
    return fail(c, "没有编辑权限", 403);
  }

  let body: { label?: unknown; entryId?: unknown; x?: unknown; y?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) : marker.label;

  let entryId: string | null = marker.entry_id;
  if (body.entryId === null || body.entryId === "") {
    entryId = null;
  } else if (typeof body.entryId === "string") {
    const entry = await c.env.DB.prepare("SELECT id FROM entries WHERE id = ? AND world_id = ?")
      .bind(body.entryId, loaded.map.world_id)
      .first();
    if (!entry) {
      return fail(c, "关联条目不存在");
    }
    entryId = body.entryId;
  }

  // 坐标：画布编辑器拖动标记时提交（0~1 相对比例，与既有约定一致）
  let nextX = marker.x;
  let nextY = marker.y;
  if (body.x !== undefined || body.y !== undefined) {
    const candidateX = Number(body.x);
    const candidateY = Number(body.y);
    if (
      !Number.isFinite(candidateX) ||
      !Number.isFinite(candidateY) ||
      candidateX < 0 ||
      candidateX > 1 ||
      candidateY < 0 ||
      candidateY > 1
    ) {
      return fail(c, "标记坐标不正确");
    }
    nextX = candidateX;
    nextY = candidateY;
  }

  await c.env.DB.prepare("UPDATE markers SET label = ?, entry_id = ?, x = ?, y = ? WHERE id = ?")
    .bind(label, entryId, nextX, nextY, marker.id)
    .run();
  return ok(c, { updated: true });
});

/** 删除标记 */
mapRoutes.delete("/markers/:markerId", requireLogin, async (c) => {
  const user = getUser(c);
  const marker = await c.env.DB.prepare("SELECT * FROM markers WHERE id = ?")
    .bind(c.req.param("markerId"))
    .first<MarkerRow>();
  if (!marker) {
    return fail(c, "标记不存在", 404);
  }
  const loaded = await loadMapWithAccess(c.env.DB, marker.map_id, user.id);
  if (!loaded || !canEdit(loaded.access, user.id)) {
    return fail(c, "没有编辑权限", 403);
  }

  await c.env.DB.prepare("DELETE FROM markers WHERE id = ?").bind(marker.id).run();
  return ok(c, { deleted: true });
});

export default mapRoutes;
