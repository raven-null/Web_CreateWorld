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

// 其余 API 统一解析会话
app.use("/api/*", sessionMiddleware);

/**
 * 只读接口的浏览器缓存：画布每次打开都要读世界信息、条目列表与关系图，
 * 不缓存时每次刷新都要等 Worker + D1（实测 TTFB 可达 2s，冷启动更久）。
 * 这里给「无副作用」的 GET 响应加 30 秒私有缓存，刷新时直接命中浏览器缓存。
 * 仅限这些确切路径，写接口与私有数据一律不加。
 */
const CACHEABLE_GET_PATHS = [/^\/api\/discover$/, /^\/api\/worlds\/[\w-]+$/, /^\/api\/worlds\/[\w-]+\/(entries|graph|timeline|maps)$/];

app.use("/api/*", async (c, next) => {
  await next();
  const isGet = c.req.method === "GET";
  const cacheable =
    isGet && c.res.status === 200 && CACHEABLE_GET_PATHS.some((pattern) => pattern.test(new URL(c.req.url).pathname));
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
