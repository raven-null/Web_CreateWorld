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
 * 为什么必须加：`/api/discover` 与 `/api/discover/tags` 是任何访客打开首页都会调的接口，
 * 而 Worker 冷启动实测可达 1.9s——每个用户第一次访问、或缓存过期后再访问都要吃一遍。
 * 用 Cloudflare Cache API 在边缘存 60 秒：命中时只需几十毫秒，
 * 既不要求用户做任何设置，也不受「谁先来谁等冷启动」影响。
 *
 * 只缓存这两个公开只读接口，带登录态的私有数据一律不碰。
 */
const EDGE_CACHED_PATHS = new Set(["/api/discover", "/api/discover/tags"]);
const EDGE_CACHE_TTL_SECONDS = 60;

app.use("/api/*", async (c, next) => {
  const url = new URL(c.req.url);
  const eligible = c.req.method === "GET" && EDGE_CACHED_PATHS.has(url.pathname);
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
 * 只读接口的浏览器缓存：画布每次打开都要读世界信息、条目列表与关系图。
 * 仅限「无副作用」的 GET 路径，并且**跳过首屏那两个已被边缘缓存接管的接口**
 * （见 EDGE_CACHED_PATHS）——那些接口的 Cache-Control 由边缘缓存中间件统一设置；
 * 若在这里再写成 `private`，会禁止共享缓存写入，边缘缓存就永远命中不了。
 */
const CACHEABLE_GET_PATHS = [/^\/api\/worlds\/[\w-]+$/, /^\/api\/worlds\/[\w-]+\/(entries|graph|timeline|maps)$/];

app.use("/api/*", async (c, next) => {
  await next();
  const isGet = c.req.method === "GET";
  const pathname = new URL(c.req.url).pathname;
  const cacheable =
    isGet &&
    c.res.status === 200 &&
    !EDGE_CACHED_PATHS.has(pathname) &&
    CACHEABLE_GET_PATHS.some((pattern) => pattern.test(pathname));
  if (!cacheable) {
    return;
  }
  const headers = new Headers(c.res.headers);
  // private：只进浏览器缓存不进 CDN；stale-while-revalidate 让刷新先用旧数据顶上
  headers.set("cache-control", "private, max-age=30, stale-while-revalidate=60");
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
