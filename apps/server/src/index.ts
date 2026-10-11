import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
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
 * ⚠️ 只缓存**内容与访客身份无关**的接口。
 * `/api/worlds/:id` 虽然也是公开读，但它的响应带 `canEdit` / `myRole`（随登录状态变化），
 * 放进共享缓存会把「先访问者的权限」带给后续访客（要么误判可编辑、要么误判只读），
 * 因此改用浏览器私有缓存（见下方 CACHEABLE_GET_PATHS）。
 */
const EDGE_CACHED_PATH_PATTERNS = [/^\/api\/discover$/, /^\/api\/discover\/tags$/, /^\/api\/worlds\/[\w-]+\/(entries|graph)$/];
const EDGE_CACHE_TTL_SECONDS = 60;

/** 判定某个 GET 请求是否可以走边缘缓存 */
function isEdgeCacheable(pathname: string): boolean {
  return EDGE_CACHED_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
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
    const headers = new Headers(hit.headers);
    headers.set("x-edge-cache", "hit");
    c.res = new Response(hit.body, { status: 200, headers });
    return;
  }

  await next();

  // 只缓存成功响应；带 Set-Cookie 的（登录态）绝不写入共享缓存
  if (c.res.status === 200 && !c.res.headers.has("set-cookie")) {
    const headers = new Headers(c.res.headers);
    const body = await c.res.clone().arrayBuffer();
    await caches.default.put(cacheKey, new Response(body, { status: 200, headers }));
  }
  c.res.headers.set("x-edge-cache", "miss");
  c.res.headers.set("cache-control", `public, max-age=${EDGE_CACHE_TTL_SECONDS}`);
});

// 其余 API 统一解析会话
app.use("/api/*", sessionMiddleware);

/**
 * 私有只读接口的浏览器缓存。
 *
 * 世界信息（`/api/worlds/:id`）带 `canEdit` / `myRole`，随登录状态变化，
 * **不能进共享缓存**（会把先访问者的权限带给后续访客），但可以进浏览器私有缓存：
 * 同一用户短时间内切页、返回、刷新都不必再等 Worker。时间线、地图同理。
 */
const CACHEABLE_GET_PATHS = [/^\/api\/worlds\/[\w-]+$/, /^\/api\/worlds\/[\w-]+\/(timeline|maps)$/];
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
