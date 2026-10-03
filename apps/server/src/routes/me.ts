import { Hono } from "hono";
import { ok } from "../lib/response";
import type { AppVariables } from "../middleware/session";
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

export default meRoutes;
