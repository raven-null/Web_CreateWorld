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

/** 单次请求超时：没有它，任何一次网络挂起都会让页面永远停在「加载中」且不报错 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 超时或网络抖动时的重试次数（GET 才重试，写操作不重试以免重复提交） */
const GET_RETRY_TIMES = 1;

/** 超时错误文案 */
const TIMEOUT_MESSAGE = "请求超时，网络或服务暂时不可用，请重试";

/** GET 缓存：key 为请求路径 */
const getCache = new Map<string, { at: number; data: unknown }>();

/** 进行中的 GET 请求：相同路径的并发请求合并为一次 */
const inflightGets = new Map<string, Promise<unknown>>();

/**
 * 执行真实请求并解析统一响应（带超时；超时与网络异常统一转成中文提示）。
 * @param path 接口路径
 * @param options.method 请求方法
 * @param options.body 请求体对象（自动 JSON 序列化）
 * @returns 接口 data 字段
 * @throws 接口返回 ok:false、超时或网络异常时抛出 ApiError（含中文提示）
 */
async function requestApi<T>(path: string, options: { method?: string; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: "include",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // 超时单独提示，便于判断是「服务慢」还是「完全不可达」
    const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ApiError(timedOut ? TIMEOUT_MESSAGE : "网络异常，请检查连接后重试", 0);
  }

  const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
  if (!payload || !payload.ok) {
    throw new ApiError(payload?.error ?? `请求失败（${response.status}）`, response.status, payload?.data);
  }
  return payload.data as T;
}

/**
 * GET 请求带一次重试：首次超时或网络抖动时再试一次，避免整页卡在加载中。
 * @param path 接口路径
 * @returns 接口 data 字段
 */
async function requestApiWithRetry<T>(path: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= GET_RETRY_TIMES; attempt += 1) {
    try {
      return await requestApi<T>(path, { method: "GET" });
    } catch (error) {
      lastError = error;
      // 只有超时/网络层失败才重试；接口业务错误（如 404）应立即返回
      const isTransportError = error instanceof ApiError && error.status === 0;
      if (!isTransportError || attempt === GET_RETRY_TIMES) {
        break;
      }
    }
  }
  throw lastError;
}

/**
 * 手动清空 GET 缓存。
 * 供未走 api() 的写操作（如 multipart 导入 / 上传）在完成后调用。
 */
export function clearApiCache(): void {
  getCache.clear();
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

  const promise = method === "GET" ? requestApiWithRetry<T>(path) : requestApi<T>(path, options);
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
