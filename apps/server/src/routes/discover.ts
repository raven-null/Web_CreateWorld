import { Hono } from "hono";
import type { WorldVisibility } from "@create-world/core";
import { ok } from "../lib/response";
import type { Env } from "../types";

/** 发现页世界列表的查询结果行 */
interface DiscoverRow {
  id: string;
  name: string;
  intro: string;
  cover: string | null;
  visibility: WorldVisibility;
  created_at: number;
  updated_at: number;
  owner_id: string;
  ownerName: string;
  entryCount: number;
  memberCount: number;
  tagNames: string | null;
}

/** 排序字段白名单：query 参数映射为 SQL 列，防止注入 */
const SORT_COLUMNS: Record<string, string> = {
  updated: "w.updated_at",
  created: "w.created_at",
};

const discoverRoutes = new Hono<{ Bindings: Env }>();

/**
 * 发现页世界列表：仅公开世界（公开只读 / 公开可编写）。
 * query: sort=updated|created、tag=标签名、limit、offset
 */
discoverRoutes.get("/discover", async (c) => {
  const sortKey = c.req.query("sort") === "created" ? "created" : "updated";
  const orderBy = SORT_COLUMNS[sortKey] ?? "w.updated_at";
  const tag = c.req.query("tag")?.trim() || null;
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 50);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

  const result = await c.env.DB.prepare(
    `SELECT w.id, w.name, w.intro, w.cover, w.visibility, w.created_at, w.updated_at, w.owner_id,
            u.name AS ownerName,
            (SELECT COUNT(*) FROM entries e WHERE e.world_id = w.id) AS entryCount,
            (SELECT COUNT(*) FROM world_members m WHERE m.world_id = w.id) AS memberCount,
            (SELECT GROUP_CONCAT(t.name, '、') FROM world_tags wt JOIN tags t ON t.id = wt.tag_id
              WHERE wt.world_id = w.id) AS tagNames
     FROM worlds w
     JOIN user u ON u.id = w.owner_id
     WHERE w.visibility IN ('public_read', 'public_edit')
       AND (?1 IS NULL OR EXISTS (
         SELECT 1 FROM world_tags wt2 JOIN tags t2 ON t2.id = wt2.tag_id
         WHERE wt2.world_id = w.id AND t2.name = ?1
       ))
     ORDER BY ${orderBy} DESC
     LIMIT ?2 OFFSET ?3`,
  )
    .bind(tag, limit, offset)
    .all<DiscoverRow>();

  const items = (result.results ?? []).map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    intro: row.intro,
    cover: row.cover,
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerName: row.ownerName,
    entryCount: row.entryCount,
    memberCount: row.memberCount,
    tags: row.tagNames ? row.tagNames.split("、") : [],
  }));

  return ok(c, { items, limit, offset });
});

/** 启用中的世界标签列表（发现页筛选条用） */
discoverRoutes.get("/discover/tags", async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT name FROM tags WHERE status = 'active' ORDER BY sort_order ASC",
  ).all<{ name: string }>();

  return ok(c, (result.results ?? []).map((row) => row.name));
});

export default discoverRoutes;
