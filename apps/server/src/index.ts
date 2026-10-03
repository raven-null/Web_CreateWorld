import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { sessionMiddleware, type AppVariables } from "./middleware/session";
import adminRoutes from "./routes/admin";
import categoryRoutes from "./routes/categories";
import discoverRoutes from "./routes/discover";
import entryRoutes from "./routes/entries";
import meRoutes from "./routes/me";
import migrateRoutes from "./routes/migrate";
import registerRoutes from "./routes/register";
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

app.route("/api", registerRoutes);
app.route("/api", meRoutes);
app.route("/api", discoverRoutes);
app.route("/api", worldRoutes);
app.route("/api", entryRoutes);
app.route("/api", categoryRoutes);
app.route("/api", timelineRoutes);
app.route("/api/admin", adminRoutes);

/** 健康检查与根路径提示 */
app.get("/", (c) => c.json({ ok: true, name: "create-world-api" }));

export default app;
