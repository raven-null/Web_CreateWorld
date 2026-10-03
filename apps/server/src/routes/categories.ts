import { Hono } from "hono";
import { hasRoleLevel } from "@create-world/core";
import { fail, ok } from "../lib/response";
import { loadWorldAccess } from "../lib/world-access";
import { getUser, requireLogin, type AppVariables } from "../middleware/session";
import type { Env } from "../types";

/** 单个世界的分类数量上限 */
const MAX_CATEGORIES_PER_WORLD = 30;

const categoryRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/** 新增分类（世界管理员及以上），排序值追加到末尾 */
categoryRoutes.post("/worlds/:worldId/categories", requireLogin, async (c) => {
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
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 20) : "";
  if (!name) {
    return fail(c, "请填写分类名称");
  }

  const count = await c.env.DB.prepare("SELECT COUNT(*) AS total FROM categories WHERE world_id = ?")
    .bind(access.world.id)
    .first<{ total: number }>();
  if ((count?.total ?? 0) >= MAX_CATEGORIES_PER_WORLD) {
    return fail(c, `分类数量已达上限（${MAX_CATEGORIES_PER_WORLD} 个）`);
  }

  const maxSort = await c.env.DB.prepare("SELECT MAX(sort_order) AS maxSort FROM categories WHERE world_id = ?")
    .bind(access.world.id)
    .first<{ maxSort: number | null }>();

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO categories (id, world_id, name, icon, color, sort_order) VALUES (?, ?, ?, NULL, NULL, ?)",
  )
    .bind(id, access.world.id, name, (maxSort?.maxSort ?? -1) + 1)
    .run();

  return ok(c, { id, name }, 201);
});

/** 重命名 / 调整分类排序（世界管理员及以上） */
categoryRoutes.patch("/categories/:categoryId", requireLogin, async (c) => {
  const user = getUser(c);
  const category = await c.env.DB.prepare("SELECT id, world_id FROM categories WHERE id = ?")
    .bind(c.req.param("categoryId"))
    .first<{ id: string; world_id: string }>();
  if (!category) {
    return fail(c, "分类不存在", 404);
  }
  const access = await loadWorldAccess(c.env.DB, category.world_id, user.id);
  if (!access || !access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  let body: { name?: unknown; sortOrder?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }

  const statements = [];
  if (typeof body.name === "string" && body.name.trim()) {
    statements.push(
      c.env.DB.prepare("UPDATE categories SET name = ? WHERE id = ?").bind(body.name.trim().slice(0, 20), category.id),
    );
  }
  if (Number.isInteger(Number(body.sortOrder))) {
    statements.push(
      c.env.DB.prepare("UPDATE categories SET sort_order = ? WHERE id = ?").bind(Number(body.sortOrder), category.id),
    );
  }
  if (statements.length === 0) {
    return fail(c, "没有需要更新的内容");
  }

  await c.env.DB.batch(statements);
  return ok(c, { updated: true });
});

/** 删除分类（世界管理员及以上）；分类下还有条目时拒绝删除 */
categoryRoutes.delete("/categories/:categoryId", requireLogin, async (c) => {
  const user = getUser(c);
  const category = await c.env.DB.prepare("SELECT id, world_id FROM categories WHERE id = ?")
    .bind(c.req.param("categoryId"))
    .first<{ id: string; world_id: string }>();
  if (!category) {
    return fail(c, "分类不存在", 404);
  }
  const access = await loadWorldAccess(c.env.DB, category.world_id, user.id);
  if (!access || !access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  const entryCount = await c.env.DB.prepare("SELECT COUNT(*) AS total FROM entries WHERE category_id = ?")
    .bind(category.id)
    .first<{ total: number }>();
  if ((entryCount?.total ?? 0) > 0) {
    return fail(c, "该分类下还有条目，请先移动或删除条目");
  }

  await c.env.DB.prepare("DELETE FROM categories WHERE id = ?").bind(category.id).run();
  return ok(c, { deleted: true });
});

export default categoryRoutes;
