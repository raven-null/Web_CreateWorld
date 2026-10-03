import { Hono } from "hono";
import { countWords } from "@create-world/core";
import { checkNewAccountQuota } from "../lib/quota";
import { fail, ok } from "../lib/response";
import { canEdit, loadWorldAccess } from "../lib/world-access";
import { getUser, requireLogin, type AppVariables } from "../middleware/session";
import type { Env } from "../types";

/** drafts 表数据行 */
interface DraftRow {
  id: string;
  user_id: string;
  world_id: string | null;
  content: string;
  converted_entry_id: string | null;
  created_at: number;
  updated_at: number;
}

/** 单条草稿内容长度上限 */
const MAX_DRAFT_LENGTH = 2000;

const draftRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/** 我的草稿列表（按更新时间倒序） */
draftRoutes.get("/drafts", requireLogin, async (c) => {
  const user = getUser(c);
  const result = await c.env.DB.prepare(
    `SELECT d.*, w.name AS worldName
     FROM drafts d
     LEFT JOIN worlds w ON w.id = d.world_id
     WHERE d.user_id = ?
     ORDER BY d.updated_at DESC
     LIMIT 200`,
  )
    .bind(user.id)
    .all<Record<string, unknown>>();

  return ok(
    c,
    (result.results ?? []).map((row) => ({
      id: row.id as string,
      worldId: (row.world_id as string | null) ?? null,
      worldName: (row.worldName as string | null) ?? null,
      content: row.content as string,
      convertedEntryId: (row.converted_entry_id as string | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    })),
  );
});

/** 新建草稿 body: { content, worldId? } */
draftRoutes.post("/drafts", requireLogin, async (c) => {
  const user = getUser(c);

  let body: { content?: unknown; worldId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const content = typeof body.content === "string" ? body.content.trim().slice(0, MAX_DRAFT_LENGTH) : "";
  if (!content) {
    return fail(c, "请填写内容");
  }
  const worldId = typeof body.worldId === "string" && body.worldId ? body.worldId : null;

  const now = Date.now();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO drafts (id, user_id, world_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, user.id, worldId, content, now, now)
    .run();
  return ok(c, { id }, 201);
});

/** 更新草稿（仅本人）PATCH /drafts/:id { content?, worldId? } */
draftRoutes.patch("/drafts/:draftId", requireLogin, async (c) => {
  const user = getUser(c);
  const draft = await c.env.DB.prepare("SELECT * FROM drafts WHERE id = ?")
    .bind(c.req.param("draftId"))
    .first<DraftRow>();
  if (!draft) {
    return fail(c, "草稿不存在", 404);
  }
  if (draft.user_id !== user.id) {
    return fail(c, "只能修改自己的草稿", 403);
  }

  let body: { content?: unknown; worldId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }

  const statements = [];
  if (typeof body.content === "string") {
    const content = body.content.trim().slice(0, MAX_DRAFT_LENGTH);
    if (!content) {
      return fail(c, "内容不能为空");
    }
    statements.push(c.env.DB.prepare("UPDATE drafts SET content = ?, updated_at = ? WHERE id = ?").bind(content, Date.now(), draft.id));
  }
  if (body.worldId === null || typeof body.worldId === "string") {
    const worldId = typeof body.worldId === "string" && body.worldId ? body.worldId : null;
    statements.push(c.env.DB.prepare("UPDATE drafts SET world_id = ?, updated_at = ? WHERE id = ?").bind(worldId, Date.now(), draft.id));
  }
  if (statements.length === 0) {
    return fail(c, "没有需要更新的内容");
  }

  await c.env.DB.batch(statements);
  return ok(c, { updated: true });
});

/** 删除草稿（仅本人） */
draftRoutes.delete("/drafts/:draftId", requireLogin, async (c) => {
  const user = getUser(c);
  const draft = await c.env.DB.prepare("SELECT * FROM drafts WHERE id = ?")
    .bind(c.req.param("draftId"))
    .first<DraftRow>();
  if (!draft) {
    return fail(c, "草稿不存在", 404);
  }
  if (draft.user_id !== user.id) {
    return fail(c, "只能删除自己的草稿", 403);
  }

  await c.env.DB.prepare("DELETE FROM drafts WHERE id = ?").bind(draft.id).run();
  return ok(c, { deleted: true });
});

/**
 * 草稿转为正式条目（仅本人）。
 * body: { worldId, categoryId, title }
 * 内容按行拆成段落写入条目首块；转换后草稿保留并标记去向。
 */
draftRoutes.post("/drafts/:draftId/convert", requireLogin, async (c) => {
  const user = getUser(c);
  const draft = await c.env.DB.prepare("SELECT * FROM drafts WHERE id = ?")
    .bind(c.req.param("draftId"))
    .first<DraftRow>();
  if (!draft) {
    return fail(c, "草稿不存在", 404);
  }
  if (draft.user_id !== user.id) {
    return fail(c, "只能转换自己的草稿", 403);
  }

  let body: { worldId?: unknown; categoryId?: unknown; title?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const worldId = typeof body.worldId === "string" ? body.worldId : "";
  const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : "";
  if (!worldId || !categoryId || !title) {
    return fail(c, "请选择世界与分类，并填写条目标题");
  }

  const access = await loadWorldAccess(c.env.DB, worldId, user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!canEdit(access, user.id)) {
    return fail(c, "没有编辑权限", 403);
  }
  const category = await c.env.DB.prepare("SELECT id FROM categories WHERE id = ? AND world_id = ?")
    .bind(categoryId, worldId)
    .first();
  if (!category) {
    return fail(c, "分类不存在");
  }
  if (!(await checkNewAccountQuota(c.env.DB, user))) {
    return fail(c, "新账号每日编辑次数已达上限，请明天再试", 429);
  }

  // 草稿内容按行转成 TipTap 段落
  const paragraphs = draft.content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));
  const docJson = JSON.stringify({ type: "doc", content: paragraphs });
  const wordCount = countWords(draft.content);

  const now = Date.now();
  const entryId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO entries (id, world_id, category_id, title, cover, tags, aliases, protected, word_count, version, last_editor_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, '', '', 0, ?, 1, ?, ?, ?)`,
    ).bind(entryId, worldId, categoryId, title, wordCount, user.id, now, now),
    c.env.DB.prepare(
      `INSERT INTO entry_blocks (id, entry_id, sort_order, title, content_json, text_content, word_count, version, updated_at)
       VALUES (?, ?, 0, '', ?, ?, ?, 1, ?)`,
    ).bind(crypto.randomUUID(), entryId, docJson, draft.content, wordCount, now),
    c.env.DB.prepare("UPDATE drafts SET converted_entry_id = ?, world_id = ?, updated_at = ? WHERE id = ?")
      .bind(entryId, worldId, now, draft.id),
    c.env.DB.prepare("UPDATE worlds SET updated_at = ? WHERE id = ?").bind(now, worldId),
  ]);

  return ok(c, { entryId }, 201);
});

export default draftRoutes;
