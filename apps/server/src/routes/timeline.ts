import { Hono } from "hono";
import { hasRoleLevel, type TimeGranularity, type TimeNumberStyle } from "@create-world/core";
import { fail, ok } from "../lib/response";
import { canEdit, canRead, loadWorldAccess } from "../lib/world-access";
import { getUser, requireLogin, type AppVariables } from "../middleware/session";
import type { Env } from "../types";

/** timeline_events 表数据行 */
interface EventRow {
  id: string;
  world_id: string;
  title: string;
  description: string;
  era_id: string | null;
  year: number | null;
  month: number | null;
  day: number | null;
  season: string;
  time_undetermined: number;
  entry_id: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** 事件创建 / 更新请求体 */
interface EventBody {
  title?: unknown;
  description?: unknown;
  eraId?: unknown;
  year?: unknown;
  month?: unknown;
  day?: unknown;
  season?: unknown;
  timeUndetermined?: unknown;
  entryId?: unknown;
}

const timelineRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * 校验事件请求体并规范化时间字段。
 * 规则：非时间未定时必须有纪元与年份；日需要月份。
 * @param db D1 数据库
 * @param worldId 世界 id
 * @param body 请求体
 * @returns 规范化结果或错误文案
 */
async function normalizeEventBody(
  db: D1Database,
  worldId: string,
  body: EventBody,
): Promise<{ ok: true; data: Omit<EventRow, "id" | "world_id" | "created_by" | "created_at" | "updated_at"> } | { ok: false; error: string }> {
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  if (!title) {
    return { ok: false, error: "请填写事件标题" };
  }
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 2000) : "";
  const season = typeof body.season === "string" ? body.season.trim().slice(0, 20) : "";
  const timeUndetermined = body.timeUndetermined === true;

  let eraId: string | null = null;
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;

  if (!timeUndetermined) {
    if (typeof body.eraId === "string" && body.eraId) {
      const era = await db.prepare("SELECT id FROM eras WHERE id = ? AND world_id = ?").bind(body.eraId, worldId).first();
      if (!era) {
        return { ok: false, error: "纪元不存在" };
      }
      eraId = body.eraId;
    }
    if (eraId === null) {
      return { ok: false, error: "请选择纪元" };
    }

    const parsedYear = Number(body.year);
    if (!Number.isInteger(parsedYear)) {
      return { ok: false, error: "请填写年份" };
    }
    year = parsedYear;

    if (body.month !== undefined && body.month !== null && body.month !== "") {
      const parsedMonth = Number(body.month);
      if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
        return { ok: false, error: "月份需在 1-12 之间" };
      }
      month = parsedMonth;
    }
    if (body.day !== undefined && body.day !== null && body.day !== "") {
      const parsedDay = Number(body.day);
      if (!Number.isInteger(parsedDay) || parsedDay < 1 || parsedDay > 31) {
        return { ok: false, error: "日期需在 1-31 之间" };
      }
      if (month === null) {
        return { ok: false, error: "填写日期前请先填写月份" };
      }
      day = parsedDay;
    }
  }

  let entryId: string | null = null;
  if (typeof body.entryId === "string" && body.entryId) {
    const entry = await db.prepare("SELECT id FROM entries WHERE id = ? AND world_id = ?").bind(body.entryId, worldId).first();
    if (!entry) {
      return { ok: false, error: "关联条目不存在" };
    }
    entryId = body.entryId;
  }

  return {
    ok: true,
    data: {
      title,
      description,
      era_id: eraId,
      year,
      month,
      day,
      season,
      time_undetermined: timeUndetermined ? 1 : 0,
      entry_id: entryId,
    },
  };
}

/** 时间线数据：纪元列表 + 事件列表 + 世界时间配置（需要查看权限） */
timelineRoutes.get("/worlds/:worldId/timeline", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const access = await loadWorldAccess(c.env.DB, c.req.param("worldId"), userId);
  if (!access || !canRead(access)) {
    return fail(c, "世界不存在或无权访问", 404);
  }

  const [eraResult, eventResult, world] = await Promise.all([
    c.env.DB.prepare("SELECT id, name, sort_order FROM eras WHERE world_id = ? ORDER BY sort_order ASC, created_at ASC")
      .bind(access.world.id)
      .all<{ id: string; name: string; sort_order: number }>(),
    c.env.DB.prepare("SELECT * FROM timeline_events WHERE world_id = ? LIMIT 500")
      .bind(access.world.id)
      .all<EventRow>(),
    c.env.DB.prepare("SELECT time_granularity, time_number_style FROM worlds WHERE id = ?")
      .bind(access.world.id)
      .first<{ time_granularity: TimeGranularity; time_number_style: TimeNumberStyle }>(),
  ]);

  return ok(c, {
    eras: (eraResult.results ?? []).map((row) => ({ id: row.id, name: row.name, sortOrder: row.sort_order })),
    events: (eventResult.results ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      eraId: row.era_id,
      year: row.year,
      month: row.month,
      day: row.day,
      season: row.season,
      timeUndetermined: Boolean(row.time_undetermined),
      entryId: row.entry_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    timeConfig: {
      granularity: world?.time_granularity ?? "day",
      numberStyle: world?.time_number_style ?? "arabic",
    },
    canEdit: canEdit(access, userId),
  });
});

/** 新增纪元（世界管理员及以上） */
timelineRoutes.post("/worlds/:worldId/eras", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("worldId"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  let body: { name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 30) : "";
  if (!name) {
    return fail(c, "请填写纪元名称");
  }

  const maxSort = await c.env.DB.prepare("SELECT MAX(sort_order) AS maxSort FROM eras WHERE world_id = ?")
    .bind(access.world.id)
    .first<{ maxSort: number | null }>();

  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO eras (id, world_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, access.world.id, name, (maxSort?.maxSort ?? -1) + 1, Date.now())
    .run();
  return ok(c, { id, name }, 201);
});

/** 重命名纪元（世界管理员及以上） */
timelineRoutes.patch("/eras/:eraId", requireLogin, async (c) => {
  const user = getUser(c);
  const era = await c.env.DB.prepare("SELECT id, world_id FROM eras WHERE id = ?")
    .bind(c.req.param("eraId"))
    .first<{ id: string; world_id: string }>();
  if (!era) {
    return fail(c, "纪元不存在", 404);
  }
  const access = await loadWorldAccess(c.env.DB, era.world_id, user.id);
  if (!access || !access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  let body: { name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 30) : "";
  if (!name) {
    return fail(c, "请填写纪元名称");
  }

  await c.env.DB.prepare("UPDATE eras SET name = ? WHERE id = ?").bind(name, era.id).run();
  return ok(c, { updated: true });
});

/** 删除纪元（世界管理员及以上）；仍被事件使用时拒绝删除 */
timelineRoutes.delete("/eras/:eraId", requireLogin, async (c) => {
  const user = getUser(c);
  const era = await c.env.DB.prepare("SELECT id, world_id FROM eras WHERE id = ?")
    .bind(c.req.param("eraId"))
    .first<{ id: string; world_id: string }>();
  if (!era) {
    return fail(c, "纪元不存在", 404);
  }
  const access = await loadWorldAccess(c.env.DB, era.world_id, user.id);
  if (!access || !access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  const used = await c.env.DB.prepare("SELECT COUNT(*) AS total FROM timeline_events WHERE era_id = ?")
    .bind(era.id)
    .first<{ total: number }>();
  if ((used?.total ?? 0) > 0) {
    return fail(c, "该纪元下还有事件，请先调整事件时间");
  }

  await c.env.DB.prepare("DELETE FROM eras WHERE id = ?").bind(era.id).run();
  return ok(c, { deleted: true });
});

/** 更新世界时间配置（世界管理员及以上） */
timelineRoutes.patch("/worlds/:worldId/time-settings", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("worldId"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  let body: { granularity?: unknown; numberStyle?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const granularity = body.granularity;
  const numberStyle = body.numberStyle;
  if (!["year", "month", "day"].includes(String(granularity))) {
    return fail(c, "时间粒度不正确");
  }
  if (!["arabic", "chinese"].includes(String(numberStyle))) {
    return fail(c, "数字风格不正确");
  }

  await c.env.DB.prepare("UPDATE worlds SET time_granularity = ?, time_number_style = ? WHERE id = ?")
    .bind(granularity, numberStyle, access.world.id)
    .run();
  return ok(c, { granularity, numberStyle });
});

/** 新增时间线事件（具备编辑权限即可） */
timelineRoutes.post("/worlds/:worldId/events", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("worldId"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!canEdit(access, user.id)) {
    return fail(c, "没有编辑权限", 403);
  }

  let body: EventBody;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const normalized = await normalizeEventBody(c.env.DB, access.world.id, body);
  if (!normalized.ok) {
    return fail(c, normalized.error);
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const data = normalized.data;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO timeline_events
         (id, world_id, title, description, era_id, year, month, day, season, time_undetermined, entry_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      access.world.id,
      data.title,
      data.description,
      data.era_id,
      data.year,
      data.month,
      data.day,
      data.season,
      data.time_undetermined,
      data.entry_id,
      user.id,
      now,
      now,
    ),
    c.env.DB.prepare("UPDATE worlds SET updated_at = ? WHERE id = ?").bind(now, access.world.id),
  ]);

  return ok(c, { id }, 201);
});

/** 更新事件（具备编辑权限即可） */
timelineRoutes.patch("/events/:eventId", requireLogin, async (c) => {
  const user = getUser(c);
  const event = await c.env.DB.prepare("SELECT * FROM timeline_events WHERE id = ?")
    .bind(c.req.param("eventId"))
    .first<EventRow>();
  if (!event) {
    return fail(c, "事件不存在", 404);
  }
  const access = await loadWorldAccess(c.env.DB, event.world_id, user.id);
  if (!access || !canEdit(access, user.id)) {
    return fail(c, "没有编辑权限", 403);
  }

  let body: EventBody;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const normalized = await normalizeEventBody(c.env.DB, event.world_id, body);
  if (!normalized.ok) {
    return fail(c, normalized.error);
  }

  const data = normalized.data;
  await c.env.DB.prepare(
    `UPDATE timeline_events
     SET title = ?, description = ?, era_id = ?, year = ?, month = ?, day = ?, season = ?, time_undetermined = ?, entry_id = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      data.title,
      data.description,
      data.era_id,
      data.year,
      data.month,
      data.day,
      data.season,
      data.time_undetermined,
      data.entry_id,
      Date.now(),
      event.id,
    )
    .run();
  return ok(c, { updated: true });
});

/** 删除事件：编辑者本人或世界管理员及以上 */
timelineRoutes.delete("/events/:eventId", requireLogin, async (c) => {
  const user = getUser(c);
  const event = await c.env.DB.prepare("SELECT * FROM timeline_events WHERE id = ?")
    .bind(c.req.param("eventId"))
    .first<EventRow>();
  if (!event) {
    return fail(c, "事件不存在", 404);
  }
  const access = await loadWorldAccess(c.env.DB, event.world_id, user.id);
  if (!access || !canEdit(access, user.id)) {
    return fail(c, "没有编辑权限", 403);
  }
  const isCreator = event.created_by === user.id;
  const isAdmin = access.role !== null && hasRoleLevel(access.role, "admin");
  if (!isCreator && !isAdmin) {
    return fail(c, "只能删除自己创建的事件", 403);
  }

  await c.env.DB.prepare("DELETE FROM timeline_events WHERE id = ?").bind(event.id).run();
  return ok(c, { deleted: true });
});

export default timelineRoutes;
