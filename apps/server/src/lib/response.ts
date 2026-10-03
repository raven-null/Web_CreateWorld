import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * 成功响应统一格式：{ ok: true, data }
 * @param c Hono 上下文
 * @param data 返回数据
 * @param status HTTP 状态码，默认 200
 */
export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  return c.json({ ok: true as const, data }, status);
}

/**
 * 失败响应统一格式：{ ok: false, error }
 * @param c Hono 上下文
 * @param error 面向用户的错误文案
 * @param status HTTP 状态码，默认 400
 */
export function fail(c: Context, error: string, status: ContentfulStatusCode = 400) {
  return c.json({ ok: false as const, error }, status);
}
