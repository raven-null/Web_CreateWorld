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

/** GET 请求短缓存时长：减少页面切换时的重复请求 */
const GET_CACHE_TTL_MS = 10_000;

/** GET 缓存：key 为请求路径 */
const getCache = new Map<string, { at: number; data: unknown }>();

/** 进行中的 GET 请求：相同路径的并发请求合并为一次 */
const inflightGets = new Map<string, Promise<unknown>>();

/**
 * 执行真实请求并解析统一响应。
 * @param path 接口路径
 * @param options.method 请求方法
 * @param options.body 请求体对象（自动 JSON 序列化）
 * @returns 接口 data 字段
 * @throws 接口返回 ok:false 或网络异常时抛出 ApiError（含中文提示）
 */
async function requestApi<T>(path: string, options: { method?: string; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: "include",
    });
  } catch {
    // 网络层异常（断网、服务不可达）统一转为中文提示
    throw new ApiError("网络异常，请检查连接后重试", 0);
  }

  const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
  if (!payload || !payload.ok) {
    throw new ApiError(payload?.error ?? `请求失败（${response.status}）`, response.status, payload?.data);
  }
  return payload.data as T;
}

/**
 * 调用后端 JSON API。
 * 特性：GET 请求有 10 秒短缓存与并发合并（页面来回切换秒开）；任何写操作立即清空缓存。
 * @param path 接口路径，如 /api/discover
 * @param options.method 请求方法，默认 GET
 * @param options.body 请求体对象（自动 JSON 序列化）
 * @returns 接口 data 字段
 */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? "GET";

  if (method === "GET") {
    const cached = getCache.get(path);
    if (cached && Date.now() - cached.at < GET_CACHE_TTL_MS) {
      return cached.data as T;
    }
    const pending = inflightGets.get(path);
    if (pending) {
      return pending as Promise<T>;
    }
  } else {
    // 写操作后缓存立即失效，保证返回列表页能看到最新数据
    getCache.clear();
  }

  const promise = requestApi<T>(path, options);
  if (method === "GET") {
    inflightGets.set(path, promise);
    void promise.then(
      (data) => {
        getCache.set(path, { at: Date.now(), data });
        inflightGets.delete(path);
      },
      () => {
        inflightGets.delete(path);
      },
    );
  }
  return promise;
}
