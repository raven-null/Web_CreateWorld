import { Hono } from "hono";
import { fail, ok } from "../lib/response";
import { getUser, requireLogin, type AppVariables } from "../middleware/session";
import type { Env } from "../types";

/** 可选的举报对象类型 */
const TARGET_TYPES = new Set(["world", "entry", "user"]);

const reportRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * 提交举报（世界 / 条目 / 用户）。
 * body: { targetType, targetId, reason, detail? }
 * 同一用户对同一对象只保留一条待处理举报。
 */
reportRoutes.post("/reports", requireLogin, async (c) => {
  const user = getUser(c);

  let body: { targetType?: unknown; targetId?: unknown; reason?: unknown; detail?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }

  const targetType = typeof body.targetType === "string" ? body.targetType : "";
  const targetId = typeof body.targetId === "string" ? body.targetId : "";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 30) : "";
  const detail = typeof body.detail === "string" ? body.detail.trim().slice(0, 500) : "";

  if (!TARGET_TYPES.has(targetType)) {
    return fail(c, "举报对象类型不正确");
  }
  if (!targetId || !reason) {
    return fail(c, "请选择举报原因");
  }
  if (targetType === "user" && targetId === user.id) {
    return fail(c, "不能举报自己");
  }

  // 校验对象存在，并解析所属世界（用户举报无世界）
  let worldId: string | null = null;
  if (targetType === "world") {
    const world = await c.env.DB.prepare("SELECT id FROM worlds WHERE id = ?").bind(targetId).first();
    if (!world) {
      return fail(c, "举报的世界不存在", 404);
    }
    worldId = targetId;
  } else if (targetType === "entry") {
    const entry = await c.env.DB.prepare("SELECT id, world_id FROM entries WHERE id = ?")
      .bind(targetId)
      .first<{ id: string; world_id: string }>();
    if (!entry) {
      return fail(c, "举报的条目不存在", 404);
    }
    worldId = entry.world_id;
  } else {
    const target = await c.env.DB.prepare("SELECT id FROM user WHERE id = ?").bind(targetId).first();
    if (!target) {
      return fail(c, "举报的用户不存在", 404);
    }
  }

  // 去重：同一用户对同一对象只保留一条待处理举报
  const existing = await c.env.DB.prepare(
    "SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'pending'",
  )
    .bind(user.id, targetType, targetId)
    .first();
  if (existing) {
    return fail(c, "你已提交过举报，正在等待处理");
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO reports (id, reporter_id, world_id, target_type, target_id, reason, detail, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(id, user.id, worldId, targetType, targetId, reason, detail, Date.now())
    .run();

  return ok(c, { id }, 201);
});

export default reportRoutes;
