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
 * 首屏公开接口的**边缘缓存**（挂在会话解析之前：这类请求无需认证，也就不必查会话）。
 *
 * 为什么必须加：条目列表、关系图是访客点进某个世界时**必然要调**的接口，而 Worker 冷启动
 * 实测可达 1.9s、跨境往返再叠几百毫秒——用户点一下卡片就要等好几秒，甚至触发前端 8 秒超时。
 * 用 Cloudflare Cache API 在边缘存 60 秒：命中时只需几十毫秒，谁先来都不用吃冷启动。
 *
 * ⚠️ 缓存内容必须与访客身份无关。
 * `/api/worlds/:id` 的响应带 `canEdit` / `myRole`（随登录状态变化），直接缓存会串味；
 * 因此这里在写入前剥掉这两个字段，命中后再按**当前访客**重新计算（见下方权限注入中间件），
 * 于是它也能享受边缘缓存的速度，同时不会把别人的权限看到。
 */
const EDGE_CACHED_PATH_PATTERNS = [
  /^\/api\/discover$/,
  /^\/api\/discover\/tags$/,
  /^\/api\/worlds\/[\w-]+$/,
  /^\/api\/worlds\/[\w-]+\/(entries|graph)$/,
];
const EDGE_CACHE_TTL_SECONDS = 60;

/** 判定某个 GET 请求是否可以走边缘缓存 */
function isEdgeCacheable(pathname: string): boolean {
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

app.use("/api/*", async (c, next) => {
  const url = new URL(c.req.url);
  const eligible = c.req.method === "GET" && isEdgeCacheable(url.pathname);
  if (!eligible || typeof caches === "undefined") {
    await next();
    return;
  }

  const cacheKey = new Request(url.toString(), { method: "GET" });
  const hit = await caches.default.match(cacheKey);
  if (hit) {
    // 命中缓存：把公共内容直接交给前端；权限字段随后由权限注入中间件补齐
    const headers = new Headers(hit.headers);
    headers.set("x-edge-cache", "hit");
    c.res = new Response(hit.body, { status: 200, headers });
    return;
  }

  await next();

  // 只缓存成功响应；带 Set-Cookie 的（登录态）绝不写入共享缓存
  if (c.res.status === 200 && !c.res.headers.has("set-cookie")) {
    try {
      const payload = stripVisitorFields((await c.res.clone().json()) as unknown);
      const headers = new Headers(c.res.headers);
      headers.set("content-type", "application/json; charset=utf-8");
      headers.delete("set-cookie");
      await caches.default.put(cacheKey, new Response(JSON.stringify(payload), { status: 200, headers }));
    } catch {
      // 非 JSON（例如图片）不缓存内容，避免把二进制塞进边缘缓存
    }
  }
  c.res.headers.set("x-edge-cache", "miss");
  c.res.headers.set("cache-control", `public, max-age=${EDGE_CACHE_TTL_SECONDS}`);
});

// 其余 API 统一解析会话
app.use("/api/*", sessionMiddleware);

/**
 * 权限字段注入：命中边缘缓存的「世界信息」响应里没有 `myRole` / `canEdit`，
 * 这里按**当前会话**重新计算并补上（一次按主键查询世界、一次按复合主键查成员，都在索引上，开销可忽略）。
 * 这是让世界信息接口能安全进边缘缓存的关键：公共内容走缓存，权限永远实时算。
 */
app.use("/api/*", async (c, next) => {
  await next();
  if (c.res.headers.get("x-edge-cache") !== "hit" || c.res.status !== 200) {
    return;
  }
  const url = new URL(c.req.url);
  if (!/^\/api\/worlds\/[\w-]+$/.test(url.pathname)) {
    return;
  }
  try {
    const payload = (await c.res.clone().json()) as { data?: Record<string, unknown> };
    if (!payload?.data || typeof payload.data !== "object") {
      return;
    }
    const worldId = url.pathname.split("/").pop() ?? "";
    const userId = c.get("user")?.id ?? null;
    const access = await loadWorldAccess(c.env.DB, worldId, userId);
    if (!access) {
      return;
    }
    const data = { ...payload.data };
    data.myRole = access.role;
    data.canEdit = canEdit(access, userId) && !access.banned;
    const headers = new Headers(c.res.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    c.res = new Response(JSON.stringify({ ...payload, data }), { status: 200, headers });
  } catch {
    // 注入失败就保持公共字段，前端会退化成只读展示
  }
});

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
