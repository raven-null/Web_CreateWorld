import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { canEdit, loadWorldAccess } from "./lib/world-access";
import { sessionMiddleware, type AppVariables } from "./middleware/session";
import adminRoutes from "./routes/admin";
import aiRoutes from "./routes/ai";
import canvasRoutes from "./routes/canvas";
import categoryRoutes from "./routes/categories";
import discoverRoutes from "./routes/discover";
import draftRoutes from "./routes/drafts";
import entryRoutes from "./routes/entries";
import exportRoutes from "./routes/export";
import imageRoutes from "./routes/images";
import importRoutes from "./routes/imports";
import mapRoutes from "./routes/maps";
import meRoutes from "./routes/me";
import migrateRoutes from "./routes/migrate";
import registerRoutes from "./routes/register";
import reportRoutes from "./routes/reports";
import timelineRoutes from "./routes/timeline";
import worldRoutes from "./routes/worlds";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// 本地开发时允许 Vite 前端跨域调用（生产与 API 同域部署，不受影响）
app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  }),
);

// better-auth 路由：登录 / 登出 / 会话等由它提供
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// 迁移接口不依赖会话，挂在会话中间件之前（首次部署时认证表尚未创建）
app.route("/api", migrateRoutes);

/**
 * 判定「这个路径是否真的是某个世界的详情」。
 *
 * ⚠️ 必须排除保留字：`/api/worlds/mine` 是「我的世界列表」接口，返回的是**数组**，
 * 但它的形状和 `/api/worlds/:id` 一模一样（`mine` 也能匹配 `[\w-]+`）。
 * 早先没排除，结果列表接口被当成世界详情走了缓存与权限注入，
 * 前端拿到的数据结构变了，直接抛 `TypeError: m.map is not a function`。
 */
const RESERVED_WORLD_SUBPATHS = new Set(["mine", "new", "search"]);

/**
 * 从世界相关路径中取出世界 id（不是世界详情时返回 null）。
 * @param pathname 请求路径
 * @returns 世界 id 或 null
 */
function parseWorldIdPath(pathname: string): string | null {
  const matched = /^\/api\/worlds\/([\w-]+)$/.exec(pathname);
  const candidate = matched?.[1];
  if (!candidate) {
    return null;
  }
  return RESERVED_WORLD_SUBPATHS.has(candidate) ? null : candidate;
}

/**
 * 首屏公开接口的**边缘缓存**（挂在会话解析之前：这类请求无需认证，也就不必查会话）。
 *
 * 为什么必须加：条目列表、关系图、世界信息是访客点进某个世界时**必然要调**的接口，
 * 而 Worker 冷启动实测可达 1.9s、跨境往返再叠几百毫秒——用户点一下卡片就要等好几秒，
 * 甚至触发前端 8 秒超时。用 Cloudflare Cache API 在边缘存 30 秒：命中时只需几十毫秒。
 *
 * ⚠️ 缓存内容必须与访客身份无关。
 * `/api/worlds/:id` 的响应带 `canEdit` / `myRole`（随登录状态变化），直接缓存会串味；
 * 因此写入前剥掉这两个字段，命中后再按**当前访客**重新计算（见下方合并的中间件）。
 */
const EDGE_CACHED_PATH_PATTERNS = [
  /^\/api\/discover$/,
  /^\/api\/discover\/tags$/,
  /^\/api\/worlds\/[\w-]+\/(entries|graph)$/,
];
const EDGE_CACHE_TTL_SECONDS = 30;

/** 判定某个 GET 请求是否可以走边缘缓存 */
function isEdgeCacheable(pathname: string): boolean {
  if (parseWorldIdPath(pathname) !== null) {
    return true;
  }
  return EDGE_CACHED_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

/** 只属于当前访客的字段：不写进共享缓存，命中缓存的请求由权限注入中间件补齐 */
const VISITOR_SCOPED_FIELDS = ["canEdit", "myRole"] as const;

/**
 * 从 `{ ok, data }` 形态的 JSON 中移除访客相关字段。
 * @param payload 响应体
 * @returns 移除后的响应体（解析失败时原样返回）
 */
function stripVisitorFields(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const record = payload as { data?: unknown };
  if (!record.data || typeof record.data !== "object") {
    return payload;
  }
  const data = { ...(record.data as Record<string, unknown>) };
  for (const field of VISITOR_SCOPED_FIELDS) {
    delete data[field];
  }
  return { ...record, data };
}

/**
 * 边缘缓存 + 权限注入（合并为一个中间件）。
 *
 * 为什么合并：先写成「缓存中间件 + 后面的权限注入中间件」两个，但实测缓存命中时
 * 后续中间件不会被执行（响应已由缓存直接产出），权限注入因此从未生效——登录用户被当成只读。
 * 合并后顺序完全在内部掌握：
 *   命中缓存 → 用缓存的公共数据 + **按当前访客实时算出的权限** 组装响应
 *   未命中   → 交给后续路由，再把结果去掉访客字段写入缓存
 */
app.use("/api/*", async (c, next) => {
  const url = new URL(c.req.url);
  /** 命中缓存时携带的公共数据（与身份无关） */
  let cachedPublic: Record<string, unknown> | null = null;
  let cacheKey: Request | null = null;

  if (c.req.method === "GET" && isEdgeCacheable(url.pathname) && typeof caches !== "undefined") {
    cacheKey = new Request(url.toString(), { method: "GET" });
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      try {
        const body = (await hit.clone().json()) as { data?: Record<string, unknown> };
        cachedPublic = body?.data ?? null;
      } catch {
        cachedPublic = null;
      }
    }
  }

  await next();

  // 权限字段：按当前访客实时计算，绝不来自缓存（只对「世界详情」生效，`/worlds/mine` 这类列表接口要排除）
  const worldIdInPath = parseWorldIdPath(url.pathname);
  if (cachedPublic) {
    // 形状兜底：只有确实像世界详情（有 id 与 name）才按详情返回，避免把列表接口改坏
    const looksLikeWorld = typeof cachedPublic.id === "string" && typeof cachedPublic.name === "string";
    if (!looksLikeWorld) {
      return;
    }
    const payload: Record<string, unknown> = { ok: true, data: { ...cachedPublic } };
    if (worldIdInPath) {
      try {
        const userId = c.get("user")?.id ?? null;
        const access = await loadWorldAccess(c.env.DB, worldIdInPath, userId);
        const data = payload.data as Record<string, unknown>;
        data.myRole = access?.role ?? null;
        data.canEdit = Boolean(access && canEdit(access, userId) && !access.banned);
      } catch {
        // 权限计算失败就退化为只读展示，避免误判为可编辑
        const data = payload.data as Record<string, unknown>;
        data.myRole = null;
        data.canEdit = false;
      }
    }
    const headers = new Headers(c.res.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("x-edge-cache", "hit");
    c.res = new Response(JSON.stringify(payload), { status: 200, headers });
    return;
  }

  if (!cacheKey) {
    return;
  }

  // 未命中：把公共部分写入缓存（剥离访客字段），并标记本次为 miss
  if (c.res.status === 200 && !c.res.headers.has("set-cookie")) {
    try {
      const payload = stripVisitorFields((await c.res.clone().json()) as unknown);
      const headers = new Headers(c.res.headers);
      headers.set("content-type", "application/json; charset=utf-8");
      headers.delete("set-cookie");
      await caches.default.put(cacheKey, new Response(JSON.stringify(payload), { status: 200, headers }));
    } catch {
      // 非 JSON 响应不写入缓存
    }
  }
  c.res.headers.set("x-edge-cache", "miss");
  c.res.headers.set("cache-control", `public, max-age=${EDGE_CACHE_TTL_SECONDS}`);
});

// 其余 API 统一解析会话
app.use("/api/*", sessionMiddleware);

/**
 * 私有只读接口的浏览器缓存。
 *
 * 时间线、地图这类数据随世界变化但不随访客变化，走浏览器私有缓存即可
 * （世界信息已由上面的边缘缓存接管，不在这里重复处理）。
 */
const CACHEABLE_GET_PATHS = [/^\/api\/worlds\/[\w-]+\/(timeline|maps)$/];
const PRIVATE_CACHE_SECONDS = 60;

app.use("/api/*", async (c, next) => {
  await next();
  const isGet = c.req.method === "GET";
  const pathname = new URL(c.req.url).pathname;
  // 已被边缘缓存接管的公开接口不再重复处理（那里会写成 private，反而会禁止共享缓存写入）
  const cacheable =
    isGet &&
    c.res.status === 200 &&
    !isEdgeCacheable(pathname) &&
    CACHEABLE_GET_PATHS.some((pattern) => pattern.test(pathname));
  if (!cacheable) {
    return;
  }
  const headers = new Headers(c.res.headers);
  // private：只进浏览器缓存不进共享缓存；stale-while-revalidate 让刷新先用旧数据顶上
  headers.set("cache-control", `private, max-age=${PRIVATE_CACHE_SECONDS}, stale-while-revalidate=120`);
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
});

app.route("/api", registerRoutes);
app.route("/api", meRoutes);
app.route("/api", discoverRoutes);
app.route("/api", worldRoutes);
app.route("/api", entryRoutes);
app.route("/api", categoryRoutes);
app.route("/api", timelineRoutes);
app.route("/api", reportRoutes);
app.route("/api", aiRoutes);
app.route("/api", imageRoutes);
app.route("/api", mapRoutes);
app.route("/api", canvasRoutes);
app.route("/api", importRoutes);
app.route("/api", draftRoutes);
app.route("/api", exportRoutes);
app.route("/api/admin", adminRoutes);

/** 健康检查与根路径提示 */
app.get("/", (c) => c.json({ ok: true, name: "create-world-api" }));
export default app;
