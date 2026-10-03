import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { deleteEntryCascade, deleteWorldCascade } from "../lib/delete-cascade";
import { fail, ok } from "../lib/response";
import type { AppVariables } from "../middleware/session";
import type { Env } from "../types";

const adminRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/** 站点管理员校验：非管理员一律 403 */
const requireSiteAdmin = createMiddleware<{
  Bindings: Env;
  Variables: AppVariables;
}>(async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    return c.json({ ok: false as const, error: "无权限" }, 403);
  }
  await next();
});

adminRoutes.use("*", requireSiteAdmin);

/**
 * 写入管理操作日志（审计）。
 * @param db D1 数据库
 * @param adminId 操作的管理员 id
 * @param action 动作标识，如 create_invite
 * @param targetType 对象类型，如 invite / user / world
 * @param targetId 对象 id，可为空
 * @param detail 补充说明
 */
async function writeAuditLog(
  db: D1Database,
  adminId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  detail: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_audit_logs (id, admin_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), adminId, action, targetType, targetId, detail, Date.now())
    .run();
}

/** 用户列表（最多 200 条，按注册时间倒序） */
adminRoutes.get("/users", async (c) => {
  // 注意：better-auth 的 user 表时间字段为 camelCase（createdAt）
  const result = await c.env.DB.prepare(
    `SELECT id, username, name, email, role, status, createdAt
     FROM user
     ORDER BY createdAt DESC
     LIMIT 200`,
  ).all<Record<string, unknown>>();

  return ok(
    c,
    (result.results ?? []).map((row) => ({
      id: row.id as string,
      username: (row.username as string | null) ?? "",
      displayName: row.name as string,
      email: row.email as string,
      role: (row.role as string | null) ?? "user",
      status: (row.status as string | null) ?? "active",
      createdAt: row.createdAt as number,
    })),
  );
});

/**
 * 邀请码管理列表（含世界名称，最多 100 条）。
 */
adminRoutes.get("/invites", async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT i.*, w.name AS worldName
     FROM invite_codes i
     LEFT JOIN worlds w ON w.id = i.world_id
     ORDER BY i.created_at DESC
     LIMIT 100`,
  ).all<Record<string, unknown>>();

  return ok(
    c,
    (result.results ?? []).map((row) => ({
      id: row.id as string,
      code: row.code as string,
      scope: row.scope as string,
      worldId: (row.world_id as string | null) ?? null,
      worldName: (row.worldName as string | null) ?? null,
      role: (row.role as string | null) ?? null,
      maxUses: row.max_uses as number,
      usedCount: row.used_count as number,
      expiresAt: (row.expires_at as number | null) ?? null,
      status: row.status as string,
      createdAt: row.created_at as number,
    })),
  );
});

/**
 * 创建邀请码（平台码或世界码）。
 * body: { scope?: platform|world, worldId?, role?, maxUses?, expiresInDays? }
 */
adminRoutes.post("/invites", async (c) => {
  const user = c.get("user");
  if (!user) {
    return fail(c, "请先登录", 401);
  }

  let body: { scope?: unknown; worldId?: unknown; role?: unknown; maxUses?: unknown; expiresInDays?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const scope = body.scope === "world" ? "world" : "platform";
  const role =
    typeof body.role === "string" && ["admin", "editor", "viewer"].includes(body.role) ? body.role : "editor";
  const maxUses = Math.min(Math.max(Number(body.maxUses) || 1, 1), 100);
  const expiresInDays = Math.min(Math.max(Number(body.expiresInDays) || 0, 0), 365);
  const now = Date.now();

  // 世界邀请码必须指定存在的世界
  let worldId: string | null = null;
  if (scope === "world") {
    worldId = typeof body.worldId === "string" ? body.worldId : "";
    if (!worldId) {
      return fail(c, "请选择要邀请加入的世界");
    }
    const world = await c.env.DB.prepare("SELECT id FROM worlds WHERE id = ?").bind(worldId).first();
    if (!world) {
      return fail(c, "世界不存在", 404);
    }
  }

  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const code = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");

  const inviteId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO invite_codes (id, code, scope, world_id, role, created_by, max_uses, used_count, expires_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?)`,
  )
    .bind(
      inviteId,
      code,
      scope,
      worldId,
      scope === "world" ? role : null,
      user.id,
      maxUses,
      expiresInDays > 0 ? now + expiresInDays * 86400000 : null,
      now,
    )
    .run();

  await writeAuditLog(c.env.DB, user.id, "create_invite", "invite", inviteId, `创建${scope === "world" ? "世界" : "平台"}邀请码 ${code}`);

  return ok(c, { code, scope, role: scope === "world" ? role : null, maxUses }, 201);
});

/** reports 表数据行（后台使用） */
interface ReportRow {
  id: string;
  reporter_id: string;
  world_id: string | null;
  target_type: string;
  target_id: string;
  reason: string;
  detail: string;
  status: string;
  action: string;
  created_at: number;
}

/**
 * 举报列表（默认只看待处理）。
 * query: status = pending / resolved / rejected / all
 */
adminRoutes.get("/reports", async (c) => {
  const statusParam = c.req.query("status");
  const status = statusParam === "all" ? null : statusParam ?? "pending";

  const result = await c.env.DB.prepare(
    `SELECT r.*, u.name AS reporterName,
            (CASE r.target_type
               WHEN 'world' THEN (SELECT name FROM worlds w WHERE w.id = r.target_id)
               WHEN 'entry' THEN (SELECT title FROM entries e WHERE e.id = r.target_id)
               ELSE (SELECT name FROM user u2 WHERE u2.id = r.target_id)
             END) AS targetTitle
     FROM reports r
     LEFT JOIN user u ON u.id = r.reporter_id
     WHERE (?1 IS NULL OR r.status = ?1)
     ORDER BY r.created_at DESC
     LIMIT 100`,
  )
    .bind(status)
    .all<Record<string, unknown>>();

  return ok(
    c,
    (result.results ?? []).map((row) => ({
      id: row.id as string,
      reporterName: (row.reporterName as string | null) ?? "",
      targetType: row.target_type as string,
      targetId: row.target_id as string,
      targetTitle: (row.targetTitle as string | null) ?? "（已删除）",
      reason: row.reason as string,
      detail: row.detail as string,
      status: row.status as string,
      action: row.action as string,
      createdAt: row.created_at as number,
    })),
  );
});

/**
 * 处理举报。
 * body: { action: reject | delete | ban }
 * - reject：驳回
 * - delete：删除被举报的世界 / 条目内容
 * - ban：封禁相关用户（用户本人 / 世界创建者 / 条目最后编辑者）
 */
adminRoutes.post("/reports/:reportId/handle", async (c) => {
  const admin = c.get("user");
  if (!admin) {
    return fail(c, "请先登录", 401);
  }

  const report = await c.env.DB.prepare("SELECT * FROM reports WHERE id = ?")
    .bind(c.req.param("reportId"))
    .first<ReportRow>();
  if (!report) {
    return fail(c, "举报不存在", 404);
  }
  if (report.status !== "pending") {
    return fail(c, "该举报已处理");
  }

  let body: { action?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const action = typeof body.action === "string" ? body.action : "";

  let actionLabel = "";
  if (action === "reject") {
    actionLabel = "驳回";
  } else if (action === "delete") {
    if (report.target_type === "world") {
      await deleteWorldCascade(c.env.DB, report.target_id);
      actionLabel = "删除世界";
    } else if (report.target_type === "entry") {
      await deleteEntryCascade(c.env.DB, report.target_id);
      actionLabel = "删除条目";
    } else {
      return fail(c, "用户举报不支持删除内容，请使用封禁");
    }
  } else if (action === "ban") {
    // 解析相关用户：用户举报为本人；世界为创建者；条目为最后编辑者
    let userId: string | null = null;
    if (report.target_type === "user") {
      userId = report.target_id;
    } else if (report.target_type === "world") {
      const world = await c.env.DB.prepare("SELECT owner_id FROM worlds WHERE id = ?")
        .bind(report.target_id)
        .first<{ owner_id: string }>();
      userId = world?.owner_id ?? null;
    } else {
      const entry = await c.env.DB.prepare("SELECT last_editor_id FROM entries WHERE id = ?")
        .bind(report.target_id)
        .first<{ last_editor_id: string | null }>();
      userId = entry?.last_editor_id ?? null;
    }
    if (!userId) {
      return fail(c, "无法确定相关用户（内容可能已删除）");
    }
    const target = await c.env.DB.prepare("SELECT role, status FROM user WHERE id = ?")
      .bind(userId)
      .first<{ role: string; status: string }>();
    if (!target) {
      return fail(c, "相关用户不存在", 404);
    }
    if (target.role === "admin") {
      return fail(c, "不能封禁站点管理员", 403);
    }
    await c.env.DB.prepare("UPDATE user SET status = 'banned' WHERE id = ?").bind(userId).run();
    actionLabel = "封禁用户";
  } else {
    return fail(c, "处理动作不正确");
  }

  const now = Date.now();
  await c.env.DB.prepare(
    "UPDATE reports SET status = ?, action = ?, handler_id = ?, handled_at = ? WHERE id = ?",
  )
    .bind(action === "reject" ? "rejected" : "resolved", actionLabel, admin.id, now, report.id)
    .run();
  await writeAuditLog(
    c.env.DB,
    admin.id,
    "handle_report",
    "report",
    report.id,
    `处理举报（${report.target_type}：${report.target_id}）：${actionLabel}`,
  );

  return ok(c, { handled: true, action: actionLabel });
});

/**
 * 修改用户状态（禁用 / 恢复 / 封禁）。
 * body: { status: active | disabled | banned }
 * 不能修改自己或其他站点管理员。
 */
adminRoutes.post("/users/:userId/status", async (c) => {
  const admin = c.get("user");
  if (!admin) {
    return fail(c, "请先登录", 401);
  }

  const userId = c.req.param("userId");
  if (userId === admin.id) {
    return fail(c, "不能修改自己的账号状态");
  }

  let body: { status?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const status = typeof body.status === "string" ? body.status : "";
  if (!["active", "disabled", "banned"].includes(status)) {
    return fail(c, "状态不正确");
  }

  const target = await c.env.DB.prepare("SELECT role FROM user WHERE id = ?")
    .bind(userId)
    .first<{ role: string }>();
  if (!target) {
    return fail(c, "用户不存在", 404);
  }
  if (target.role === "admin") {
    return fail(c, "不能修改其他站点管理员", 403);
  }

  await c.env.DB.prepare("UPDATE user SET status = ? WHERE id = ?").bind(status, userId).run();
  const actionLabel = status === "active" ? "恢复正常" : status === "disabled" ? "禁用账号" : "封禁账号";
  await writeAuditLog(c.env.DB, admin.id, "update_user_status", "user", userId, actionLabel);

  return ok(c, { status });
});

export default adminRoutes;
