/** 后端统一响应结构 */
interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** API 错误：携带 HTTP 状态码、响应 data（冲突处理等）与本地缓存兜底数据 */
export class ApiError extends Error {
  status: number;
  data?: unknown;
  /** 网络失败时命中的本地缓存（页面可用它降级展示，避免「网络一断就白屏」） */
  cachedData?: unknown;

  constructor(message: string, status: number, data?: unknown, cachedData?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.cachedData = cachedData;
  }
}

/** GET 请求短缓存时长：减少页面切换时的重复请求 */
const GET_CACHE_TTL_MS = 10_000;

/**
 * 单次请求超时。
 * 取值考虑：网络不通时用户最多等「超时 × (1 + 重试次数)」。
 * 8 秒 + 一次重试 = 最多约 16 秒，比原先 30 秒更容易等到明确结果。
 */
const REQUEST_TIMEOUT_MS = 8_000;

/** 超时或网络抖动时的重试次数（GET 才重试，写操作不重试以免重复提交） */
const GET_RETRY_TIMES = 1;

/** 超时错误文案 */
const TIMEOUT_MESSAGE = "请求超时；网络可能无法访问服务器，稍后会自动重试";

/** 超过该耗时（毫秒）的请求会在控制台留一条警告，便于排查「页面为什么慢」 */
const SLOW_REQUEST_WARN_MS = 3000;

/** 本地缓存保存时长：网络不通时用于降级展示（跨会话保留） */
const OFFLINE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 需要离线兜底的只读接口（路径正则 + 缓存键），写接口一律不缓存 */
const OFFLINE_CACHEABLE: Array<{ pattern: RegExp; key: string }> = [
  { pattern: /^\/api\/discover(\?|$)/, key: "discover" },
  { pattern: /^\/api\/discover\/tags$/, key: "discover-tags" },
  { pattern: /^\/api\/worlds\/[\w-]+$/, key: "world" },
  { pattern: /^\/api\/worlds\/[\w-]+\/entries/, key: "world-entries" },
  { pattern: /^\/api\/worlds\/[\w-]+\/graph$/, key: "world-graph" },
];

/**
 * 判断路径是否可离线兜底。
 * @param path 接口路径
 * @returns 缓存键；不可缓存返回 null
 */
function offlineCacheKey(path: string): string | null {
  const matched = OFFLINE_CACHEABLE.find((item) => item.pattern.test(path));
  return matched ? matched.key : null;
}

/**
 * 读取离线缓存。
 * @param path 接口路径
 * @returns 缓存数据；无缓存或过期返回 null
 */
function readOfflineCache(path: string): unknown | null {
  const key = offlineCacheKey(path);
  if (!key) {
    return null;
  }
  try {
    const raw = localStorage.getItem(`create-world:api-cache:${key}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { at: number; data: unknown };
    if (Date.now() - parsed.at > OFFLINE_CACHE_TTL_MS) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * 写入离线缓存（只存最近一次成功的结果）。
 * @param path 接口路径
 * @param data 响应数据
 */
function writeOfflineCache(path: string, data: unknown): void {
  const key = offlineCacheKey(path);
  if (!key) {
    return;
  }
  try {
    localStorage.setItem(`create-world:api-cache:${key}`, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // 隐私模式或容量不足：忽略
  }
}

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
  const startedAt = Date.now();
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
    const elapsed = Date.now() - startedAt;
    console.warn(`[api] 请求失败 ${path}｜耗时 ${elapsed}ms｜${timedOut ? "超时" : "网络异常"}`);
    // 网络失败时把本地缓存一并抛出：页面可以退化成「展示上次内容 + 提示离线」
    const cached = readOfflineCache(path);
    throw new ApiError(
      timedOut ? TIMEOUT_MESSAGE : "网络异常，请检查连接后重试",
      0,
      undefined,
      cached ?? undefined,
    );
  }

  const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;

  // 慢请求埋点：网络或服务端变慢时，控制台能直接看出是哪个请求、慢在哪一段
  const elapsed = Date.now() - startedAt;
  if (elapsed >= SLOW_REQUEST_WARN_MS) {
    console.warn(`[api] 慢请求 ${path}｜耗时 ${elapsed}ms｜状态 ${response.status}`);
  }

  if (!payload || !payload.ok) {
    throw new ApiError(payload?.error ?? `请求失败（${response.status}）`, response.status, payload?.data);
  }
  // 成功后记录一份离线兜底数据
  writeOfflineCache(path, payload.data);
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
