import { Hono } from "hono";
import { fail, ok } from "../lib/response";
import { getUser, requireLogin, type AppVariables } from "../middleware/session";
import type { Env } from "../types";

const meRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * 当前登录用户信息。
 * 未登录返回 null；已登录返回公开字段（不含邮箱等敏感信息）。
 */
meRoutes.get("/me", (c) => {
  const user = c.get("user");
  if (!user) {
    return ok(c, null);
  }
  return ok(c, {
    id: user.id,
    username: user.username ?? "",
    displayName: user.name,
    avatar: user.image ?? null,
    role: user.role ?? "user",
  });
});

/** 修改昵称（展示用；用户名不可改） */
meRoutes.patch("/me", requireLogin, async (c) => {
  const user = getUser(c);

  let body: { displayName?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 24) : "";
  if (!displayName) {
    return fail(c, "请填写昵称");
  }

  await c.env.DB.prepare("UPDATE user SET name = ?, updatedAt = ? WHERE id = ?")
    .bind(displayName, Date.now(), user.id)
    .run();
  return ok(c, { displayName });
});

export default meRoutes;
