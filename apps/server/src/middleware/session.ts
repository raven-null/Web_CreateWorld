import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { auth } from "../auth";
import type { Env } from "../types";

/** Hono 上下文中可用的会话变量类型 */
export interface AppVariables {
  /** 当前会话（未登录为 null） */
  session: typeof auth.$Infer.Session | null;
  /** 当前用户（未登录为 null） */
  user: typeof auth.$Infer.Session.user | null;
}

/** 带类型上下文的简写 */
export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

/**
 * 会话中间件：每个请求解析一次登录状态，写入上下文。
 * 不阻断未登录访问，需要登录的路由自行使用 requireLogin。
 */
export const sessionMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AppVariables;
}>(async (c, next) => {
  let session: typeof auth.$Infer.Session | null = null;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers });
  } catch (error) {
    // 数据库尚未迁移等异常时按「未登录」处理，避免公开接口整体不可用
    console.error("会话解析失败：", error);
  }

  // 被禁用 / 封禁的账号按未登录处理（登录入口另有状态提示）
  const status = session ? (session.user as { status?: string }).status : undefined;
  if (session && status && status !== "active") {
    session = null;
  }

  c.set("session", session);
  c.set("user", session?.user ?? null);
  await next();
});

/** 要求登录：未登录直接返回 401 */
export const requireLogin = createMiddleware<{
  Bindings: Env;
  Variables: AppVariables;
}>(async (c, next) => {
  if (!c.get("user")) {
    return c.json({ ok: false as const, error: "请先登录" }, 401);
  }
  await next();
});

/**
 * 读取当前登录用户；未登录时抛出 401。
 * 只能用于挂在 requireLogin 之后的路由。
 * @param c Hono 上下文
 * @returns 当前用户对象
 */
export function getUser(c: AppContext) {
  const user = c.get("user");
  if (!user) {
    throw new HTTPException(401, { message: "请先登录" });
  }
  return user;
}
