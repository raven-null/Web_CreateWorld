/** 后端统一响应结构 */
interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** API 错误：携带 HTTP 状态码与响应 data（用于冲突处理等场景） */
export class ApiError extends Error {
  status: number;
  data?: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

/**
 * 调用后端 JSON API（自动携带会话 Cookie，经 Vite 代理到 Worker）。
 * @param path 接口路径，如 /api/discover
 * @param options.method 请求方法，默认 GET
 * @param options.body 请求体对象（自动 JSON 序列化）
 * @returns 接口 data 字段
 * @throws 接口返回 ok:false 或网络异常时抛出 ApiError（含中文提示）
 */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: "include",
  });

  const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
  if (!payload || !payload.ok) {
    throw new ApiError(payload?.error ?? `请求失败（${response.status}）`, response.status, payload?.data);
  }
  return payload.data as T;
}
