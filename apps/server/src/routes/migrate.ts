import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "../auth";
import type { Env } from "../types";
import { fail, ok } from "../lib/response";

const migrateRoutes = new Hono<{ Bindings: Env }>();

/**
 * 程序化数据库迁移：创建 better-auth 的 user / session / account / verification 表。
 * D1 无法被 CLI 直连，因此放在 Worker 内执行；
 * 需要请求头 x-migrate-secret 与环境变量 MIGRATE_SECRET 一致。
 */
migrateRoutes.post("/migrate", async (c) => {
  const secret = c.req.header("x-migrate-secret");
  if (!c.env.MIGRATE_SECRET || secret !== c.env.MIGRATE_SECRET) {
    return fail(c, "无权限", 403);
  }

  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
  if (toBeCreated.length === 0 && toBeAdded.length === 0) {
    return ok(c, { message: "无需迁移" });
  }

  await runMigrations();
  return ok(c, {
    created: toBeCreated.map((table) => table.table),
    added: toBeAdded.map((table) => table.table),
  });
});

export default migrateRoutes;
