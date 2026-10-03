import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
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
  const result = await c.env.DB.prepare(
    `SELECT id, username, name, email, role, status, created_at
     FROM user
     ORDER BY created_at DESC
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
      createdAt: row.created_at as number,
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

export default adminRoutes;
