import { Hono } from "hono";
import { PASSWORD_MIN_LENGTH, USERNAME_PATTERN } from "@create-world/core";
import { auth, placeholderEmail } from "../auth";
import type { Env } from "../types";
import { fail, ok } from "../lib/response";

/** invite_codes 表数据行 */
interface InviteRow {
  id: string;
  code: string;
  scope: "platform" | "world";
  world_id: string | null;
  role: "owner" | "admin" | "editor" | "viewer" | null;
  max_uses: number;
  used_count: number;
  expires_at: number | null;
  status: string;
}

/** 注册请求体 */
interface RegisterBody {
  inviteCode?: unknown;
  username?: unknown;
  password?: unknown;
  displayName?: unknown;
}

const registerRoutes = new Hono<{ Bindings: Env }>();

/**
 * 邀请码注册：邀请码 + 用户名 + 密码（本期无邮箱）。
 * 流程：校验参数 → 校验邀请码 → 预留使用次数 → 创建账号 → 按码类型加入世界。
 */
registerRoutes.post("/register", async (c) => {
  let body: RegisterBody;
  try {
    body = await c.req.json<RegisterBody>();
  } catch {
    return fail(c, "请求格式不正确");
  }

  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 24) : "";

  if (!inviteCode) {
    return fail(c, "请填写邀请码");
  }
  if (!USERNAME_PATTERN.test(username)) {
    return fail(c, "用户名需 3-24 位，以字母开头，仅含字母、数字、下划线");
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return fail(c, `密码至少 ${PASSWORD_MIN_LENGTH} 位`);
  }

  const now = Date.now();

  // 1. 解析邀请码：数据库记录优先；引导码在配置存在时直接视为有效平台码
  let invite: InviteRow | null = null;
  const bootstrapCode = (c.env.BOOTSTRAP_INVITE_CODE ?? "").trim().toUpperCase();
  const isBootstrap = bootstrapCode !== "" && inviteCode === bootstrapCode;
  if (!isBootstrap) {
    const row = await c.env.DB.prepare("SELECT * FROM invite_codes WHERE code = ?")
      .bind(inviteCode)
      .first<InviteRow>();
    const usable =
      row !== null &&
      row.status === "active" &&
      row.used_count < row.max_uses &&
      (row.expires_at === null || row.expires_at > now);
    if (!usable) {
      return fail(c, "邀请码无效或已用完");
    }
    invite = row;
  }

  // 2. 预留一次使用次数：条件更新防止并发超用
  if (invite) {
    const reserved = await c.env.DB.prepare(
      "UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ? AND status = 'active' AND used_count < max_uses",
    )
      .bind(invite.id)
      .run();
    if (!reserved.meta.changes) {
      return fail(c, "邀请码无效或已用完");
    }
  }

  /** 创建账号失败时归还预留的使用次数 */
  const releaseInvite = async () => {
    if (invite) {
      await c.env.DB.prepare("UPDATE invite_codes SET used_count = used_count - 1 WHERE id = ?")
        .bind(invite.id)
        .run();
    }
  };

  // 3. 创建账号（better-auth 负责密码哈希与用户名唯一校验）
  let createdUserId: string;
  try {
    const result = await auth.api.signUpEmail({
      body: {
        email: placeholderEmail(username),
        name: displayName || username,
        password,
        username,
      },
    });
    createdUserId = result.user.id;
  } catch (error) {
    await releaseInvite();
    const message = error instanceof Error ? error.message : "";
    if (/username/i.test(message)) {
      return fail(c, "用户名已被占用");
    }
    if (/email/i.test(message)) {
      return fail(c, "该用户名已被注册");
    }
    return fail(c, "注册失败，请稍后重试");
  }

  // 4. 初始管理员：命中 ADMIN_USERNAMES 时授予站点管理员
  const adminNames = (c.env.ADMIN_USERNAMES ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (adminNames.includes(username)) {
    await c.env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(createdUserId).run();
  }

  // 5. 世界邀请码：注册成功后自动加入对应世界
  if (invite && invite.scope === "world" && invite.world_id) {
    await c.env.DB.prepare(
      "INSERT INTO world_members (world_id, user_id, role, source, joined_at) VALUES (?, ?, ?, 'invite', ?)",
    )
      .bind(invite.world_id, createdUserId, invite.role ?? "editor", now)
      .run();
  }

  return ok(c, { username }, 201);
});

/**
 * 校验邀请码是否可用（注册页进入时预检）。
 * @returns { valid, scope, role, worldName }
 */
registerRoutes.get("/invites/:code", async (c) => {
  const code = c.req.param("code").trim().toUpperCase();
  const row = await c.env.DB.prepare("SELECT * FROM invite_codes WHERE code = ?")
    .bind(code)
    .first<InviteRow>();
  const now = Date.now();

  const valid =
    row !== null &&
    row.status === "active" &&
    row.used_count < row.max_uses &&
    (row.expires_at === null || row.expires_at > now);
  if (!row || !valid) {
    return ok(c, { valid: false });
  }

  let worldName: string | null = null;
  if (row.scope === "world" && row.world_id) {
    const world = await c.env.DB.prepare("SELECT name FROM worlds WHERE id = ?")
      .bind(row.world_id)
      .first<{ name: string }>();
    worldName = world?.name ?? null;
  }

  return ok(c, { valid: true, scope: row.scope, role: row.role, worldName });
});

export default registerRoutes;
