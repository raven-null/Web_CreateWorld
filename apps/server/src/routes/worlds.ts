import { Hono } from "hono";
import { DEFAULT_CATEGORIES, hasRoleLevel, type MemberRole, type WorldVisibility } from "@create-world/core";
import { fail, ok } from "../lib/response";
import { canEdit, canRead, loadWorldAccess } from "../lib/world-access";
import { getUser, requireLogin, type AppVariables } from "../middleware/session";
import type { Env } from "../types";

/** 世界可见性合法值集合 */
const VISIBILITIES = new Set<string>(["private", "public_read", "public_edit"]);

/** 世界邀请码允许的角色（创建者除外） */
const INVITE_ROLES = new Set<string>(["admin", "editor", "viewer"]);

const worldRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * 生成世界邀请码：8 位大写字母数字，去掉易混淆字符（0/O/1/I）。
 * @returns 邀请码字符串
 */
function generateInviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

/** 把数据库行映射为前端使用的驼峰结构 */
function toWorldSummary(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    ownerId: row.owner_id as string,
    name: row.name as string,
    intro: row.intro as string,
    cover: (row.cover as string | null) ?? null,
    visibility: row.visibility as WorldVisibility,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    ownerName: (row.ownerName as string) ?? "",
    entryCount: Number(row.entryCount ?? 0),
    memberCount: Number(row.memberCount ?? 0),
    tags: row.tagNames ? String(row.tagNames).split("、") : [],
    role: (row.role as MemberRole | undefined) ?? undefined,
  };
}

/**
 * 创建世界：写入世界 + 创建者成员 + 预设分类 + 标签关联。
 * body: { name, intro?, visibility?, tags? }
 */
worldRoutes.post("/worlds", requireLogin, async (c) => {
  const user = getUser(c);

  let body: { name?: unknown; intro?: unknown; visibility?: unknown; tags?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  const intro = typeof body.intro === "string" ? body.intro.trim().slice(0, 500) : "";
  const visibility =
    typeof body.visibility === "string" && VISIBILITIES.has(body.visibility)
      ? (body.visibility as WorldVisibility)
      : "private";
  const tagNames = Array.isArray(body.tags)
    ? body.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 5)
    : [];

  if (!name) {
    return fail(c, "请填写世界名称");
  }

  const now = Date.now();
  const worldId = crypto.randomUUID();

  // 一次批量提交：世界 + 创建者成员 + 预设分类 + 标签关联
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO worlds (id, owner_id, name, intro, cover, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
    ).bind(worldId, user.id, name, intro, visibility, now, now),
    c.env.DB.prepare(
      "INSERT INTO world_members (world_id, user_id, role, source, joined_at) VALUES (?, ?, 'owner', 'invite', ?)",
    ).bind(worldId, user.id, now),
    ...DEFAULT_CATEGORIES.map((category, index) =>
      c.env.DB.prepare(
        "INSERT INTO categories (id, world_id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, NULL, ?)",
      ).bind(crypto.randomUUID(), worldId, category.name, category.icon, index),
    ),
    ...tagNames.map((tagName) =>
      c.env.DB.prepare(
        "INSERT INTO world_tags (world_id, tag_id) SELECT ?, id FROM tags WHERE name = ? AND status = 'active'",
      ).bind(worldId, tagName),
    ),
  ];
  await c.env.DB.batch(statements);

  return ok(c, { id: worldId }, 201);
});

/** 我创建 / 参与的世界列表（附带角色与统计） */
worldRoutes.get("/worlds/mine", requireLogin, async (c) => {
  const user = getUser(c);

  const result = await c.env.DB.prepare(
    `SELECT w.id, w.owner_id, w.name, w.intro, w.cover, w.visibility, w.created_at, w.updated_at,
            m.role AS role,
            (SELECT COUNT(*) FROM entries e WHERE e.world_id = w.id) AS entryCount,
            (SELECT COUNT(*) FROM world_members m2 WHERE m2.world_id = w.id) AS memberCount,
            (SELECT GROUP_CONCAT(t.name, '、') FROM world_tags wt JOIN tags t ON t.id = wt.tag_id
              WHERE wt.world_id = w.id) AS tagNames
     FROM worlds w
     JOIN world_members m ON m.world_id = w.id AND m.user_id = ?
     ORDER BY w.updated_at DESC`,
  )
    .bind(user.id)
    .all<Record<string, unknown>>();

  return ok(c, (result.results ?? []).map(toWorldSummary));
});

/** 世界详情：基础信息 + 我的角色 + 分类 + 标签（公开世界无需登录） */
worldRoutes.get("/worlds/:id", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const access = await loadWorldAccess(c.env.DB, c.req.param("id"), userId);
  if (!access || !canRead(access)) {
    return fail(c, "世界不存在或无权访问", 404);
  }

  const [categoryResult, tagResult, owner] = await Promise.all([
    c.env.DB.prepare("SELECT id, name, icon, color, sort_order FROM categories WHERE world_id = ? ORDER BY sort_order ASC")
      .bind(access.world.id)
      .all(),
    c.env.DB.prepare(
      "SELECT t.name FROM world_tags wt JOIN tags t ON t.id = wt.tag_id WHERE wt.world_id = ? ORDER BY t.sort_order ASC",
    )
      .bind(access.world.id)
      .all<{ name: string }>(),
    c.env.DB.prepare("SELECT name FROM user WHERE id = ?")
      .bind(access.world.owner_id)
      .first<{ name: string }>(),
  ]);

  return ok(c, {
    id: access.world.id,
    ownerId: access.world.owner_id,
    ownerName: owner?.name ?? "",
    name: access.world.name,
    intro: access.world.intro,
    cover: access.world.cover,
    visibility: access.world.visibility,
    createdAt: access.world.created_at,
    updatedAt: access.world.updated_at,
    myRole: access.role,
    banned: access.banned,
    canEdit: canEdit(access, userId),
    categories: (categoryResult.results ?? []).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      icon: row.icon as string | null,
      color: row.color as string | null,
      sortOrder: row.sort_order as number,
    })),
    tags: (tagResult.results ?? []).map((row) => row.name),
  });
});

/**
 * 更新世界设置（名称 / 简介 / 可见性 / 标签）。
 * 需要世界管理员及以上角色。
 */
worldRoutes.patch("/worlds/:id", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("id"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  let body: { name?: unknown; intro?: unknown; visibility?: unknown; tags?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }

  const now = Date.now();
  const statements = [];

  if (typeof body.name === "string" && body.name.trim()) {
    statements.push(
      c.env.DB.prepare("UPDATE worlds SET name = ?, updated_at = ? WHERE id = ?")
        .bind(body.name.trim().slice(0, 60), now, access.world.id),
    );
  }
  if (typeof body.intro === "string") {
    statements.push(
      c.env.DB.prepare("UPDATE worlds SET intro = ?, updated_at = ? WHERE id = ?")
        .bind(body.intro.trim().slice(0, 500), now, access.world.id),
    );
  }
  if (typeof body.visibility === "string" && VISIBILITIES.has(body.visibility)) {
    statements.push(
      c.env.DB.prepare("UPDATE worlds SET visibility = ?, updated_at = ? WHERE id = ?")
        .bind(body.visibility, now, access.world.id),
    );
  }
  if (Array.isArray(body.tags)) {
    const tagNames = body.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 5);
    statements.push(c.env.DB.prepare("DELETE FROM world_tags WHERE world_id = ?").bind(access.world.id));
    statements.push(
      ...tagNames.map((tagName) =>
        c.env.DB.prepare(
          "INSERT INTO world_tags (world_id, tag_id) SELECT ?, id FROM tags WHERE name = ? AND status = 'active'",
        ).bind(access.world.id, tagName),
      ),
    );
  }

  if (statements.length === 0) {
    return fail(c, "没有需要更新的内容");
  }
  await c.env.DB.batch(statements);
  return ok(c, { updated: true });
});

/** 世界成员列表（公开世界或成员可看） */
worldRoutes.get("/worlds/:id/members", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const access = await loadWorldAccess(c.env.DB, c.req.param("id"), userId);
  if (!access || !canRead(access)) {
    return fail(c, "世界不存在或无权访问", 404);
  }

  const result = await c.env.DB.prepare(
    `SELECT m.user_id, m.role, m.source, m.joined_at, u.username, u.name, u.image
     FROM world_members m
     JOIN user u ON u.id = m.user_id
     WHERE m.world_id = ?
     ORDER BY m.joined_at ASC`,
  )
    .bind(access.world.id)
    .all<Record<string, unknown>>();

  return ok(
    c,
    (result.results ?? []).map((row) => ({
      userId: row.user_id as string,
      username: (row.username as string | null) ?? "",
      displayName: row.name as string,
      avatar: (row.image as string | null) ?? null,
      role: row.role as MemberRole,
      source: row.source as string,
      joinedAt: row.joined_at as number,
    })),
  );
});

/**
 * 生成世界邀请码（世界管理员及以上）。
 * body: { role?: editor|viewer|admin, maxUses?: 1-100, expiresInDays?: 1-365 }
 */
worldRoutes.post("/worlds/:id/invites", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("id"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  let body: { role?: unknown; maxUses?: unknown; expiresInDays?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const role = typeof body.role === "string" && INVITE_ROLES.has(body.role) ? body.role : "editor";
  const maxUses = Math.min(Math.max(Number(body.maxUses) || 1, 1), 100);
  const expiresInDays = Math.min(Math.max(Number(body.expiresInDays) || 0, 0), 365);
  const now = Date.now();
  const code = generateInviteCode();

  await c.env.DB.prepare(
    `INSERT INTO invite_codes (id, code, scope, world_id, role, created_by, max_uses, used_count, expires_at, status, created_at)
     VALUES (?, ?, 'world', ?, ?, ?, ?, 0, ?, 'active', ?)`,
  )
    .bind(
      crypto.randomUUID(),
      code,
      access.world.id,
      role,
      user.id,
      maxUses,
      expiresInDays > 0 ? now + expiresInDays * 86400000 : null,
      now,
    )
    .run();

  return ok(c, { code, role, maxUses }, 201);
});

/**
 * 加入开放编写世界：公开可编写世界的注册用户自动成为编辑。
 * 已有成员、被拉黑、非开放世界的情况分别处理。
 */
worldRoutes.post("/worlds/:id/join", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("id"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (access.role) {
    return ok(c, { joined: true, role: access.role });
  }
  if (access.banned) {
    return fail(c, "你已被该世界拉黑", 403);
  }
  if (access.world.visibility !== "public_edit") {
    return fail(c, "该世界未开放编写，无法加入", 403);
  }

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO world_members (world_id, user_id, role, source, joined_at) VALUES (?, ?, 'editor', 'open', ?)",
    ).bind(access.world.id, user.id, now),
    c.env.DB.prepare("UPDATE worlds SET updated_at = ? WHERE id = ?").bind(now, access.world.id),
  ]);
  return ok(c, { joined: true, role: "editor" });
});

/**
 * 调整成员角色（世界管理员及以上）。
 * 规则：不能改动创建者；只有创建者可任命 / 调整管理员。
 * body: { role: admin|editor|viewer }
 */
worldRoutes.patch("/worlds/:id/members/:userId", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("id"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  const targetId = c.req.param("userId");
  const target = await c.env.DB.prepare("SELECT role FROM world_members WHERE world_id = ? AND user_id = ?")
    .bind(access.world.id, targetId)
    .first<{ role: MemberRole }>();
  if (!target) {
    return fail(c, "该用户不是世界成员", 404);
  }
  if (target.role === "owner") {
    return fail(c, "不能修改创建者的角色", 403);
  }

  let body: { role?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const role = typeof body.role === "string" ? body.role : "";
  if (!["admin", "editor", "viewer"].includes(role)) {
    return fail(c, "角色不正确");
  }
  if ((role === "admin" || target.role === "admin") && access.role !== "owner") {
    return fail(c, "只有创建者可以任命或调整管理员", 403);
  }

  await c.env.DB.prepare("UPDATE world_members SET role = ? WHERE world_id = ? AND user_id = ?")
    .bind(role, access.world.id, targetId)
    .run();
  return ok(c, { userId: targetId, role });
});

/**
 * 移除成员（世界管理员及以上）。
 * query: ?ban=1 表示同时拉黑，禁止再次加入 / 编辑。
 */
worldRoutes.delete("/worlds/:id/members/:userId", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("id"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  const targetId = c.req.param("userId");
  const target = await c.env.DB.prepare("SELECT role FROM world_members WHERE world_id = ? AND user_id = ?")
    .bind(access.world.id, targetId)
    .first<{ role: MemberRole }>();
  if (!target) {
    return fail(c, "该用户不是世界成员", 404);
  }
  if (target.role === "owner") {
    return fail(c, "不能移除创建者", 403);
  }
  if (target.role === "admin" && access.role !== "owner") {
    return fail(c, "只有创建者可以移除管理员", 403);
  }

  const statements = [
    c.env.DB.prepare("DELETE FROM world_members WHERE world_id = ? AND user_id = ?").bind(access.world.id, targetId),
  ];
  if (c.req.query("ban") === "1") {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO world_bans (world_id, user_id, operator_id, reason, created_at) VALUES (?, ?, ?, '', ?)
         ON CONFLICT (world_id, user_id) DO NOTHING`,
      ).bind(access.world.id, targetId, user.id, Date.now()),
    );
  }
  await c.env.DB.batch(statements);
  return ok(c, { removed: true, banned: c.req.query("ban") === "1" });
});

/** 世界黑名单列表（世界管理员及以上） */
worldRoutes.get("/worlds/:id/bans", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("id"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  const result = await c.env.DB.prepare(
    `SELECT b.user_id, b.created_at, u.username, u.name
     FROM world_bans b
     JOIN user u ON u.id = b.user_id
     WHERE b.world_id = ?
     ORDER BY b.created_at DESC`,
  )
    .bind(access.world.id)
    .all<Record<string, unknown>>();

  return ok(
    c,
    (result.results ?? []).map((row) => ({
      userId: row.user_id as string,
      username: (row.username as string | null) ?? "",
      displayName: row.name as string,
      createdAt: row.created_at as number,
    })),
  );
});

/** 解除拉黑（世界管理员及以上） */
worldRoutes.delete("/worlds/:id/bans/:userId", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("id"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  await c.env.DB.prepare("DELETE FROM world_bans WHERE world_id = ? AND user_id = ?")
    .bind(access.world.id, c.req.param("userId"))
    .run();
  return ok(c, { unbanned: true });
});

/**
 * 删除世界（创建者或站点管理员）。
 * 级联清理成员、分类、条目、块、链接、版本、邀请码、黑名单。
 */
worldRoutes.delete("/worlds/:id", requireLogin, async (c) => {
  const user = getUser(c);
  const access = await loadWorldAccess(c.env.DB, c.req.param("id"), user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  const isOwner = access.world.owner_id === user.id;
  const isSiteAdmin = user.role === "admin";
  if (!isOwner && !isSiteAdmin) {
    return fail(c, "只有创建者可以删除世界", 403);
  }

  const worldId = access.world.id;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE entry_links SET to_entry_id = NULL WHERE to_entry_id IN (SELECT id FROM entries WHERE world_id = ?)",
    ).bind(worldId),
    c.env.DB.prepare("DELETE FROM entry_blocks WHERE entry_id IN (SELECT id FROM entries WHERE world_id = ?)").bind(worldId),
    c.env.DB.prepare("DELETE FROM entry_links WHERE from_entry_id IN (SELECT id FROM entries WHERE world_id = ?)").bind(worldId),
    c.env.DB.prepare("DELETE FROM entry_versions WHERE entry_id IN (SELECT id FROM entries WHERE world_id = ?)").bind(worldId),
    c.env.DB.prepare("DELETE FROM entries WHERE world_id = ?").bind(worldId),
    c.env.DB.prepare("DELETE FROM categories WHERE world_id = ?").bind(worldId),
    c.env.DB.prepare("DELETE FROM world_tags WHERE world_id = ?").bind(worldId),
    c.env.DB.prepare("DELETE FROM world_members WHERE world_id = ?").bind(worldId),
    c.env.DB.prepare("DELETE FROM world_bans WHERE world_id = ?").bind(worldId),
    c.env.DB.prepare("DELETE FROM invite_codes WHERE world_id = ?").bind(worldId),
    c.env.DB.prepare("DELETE FROM worlds WHERE id = ?").bind(worldId),
  ]);
  return ok(c, { deleted: true });
});

export default worldRoutes;
