import { Hono } from "hono";
import { hasRoleLevel } from "@create-world/core";
import { deleteEntryCascade } from "../lib/delete-cascade";
import { checkNewAccountQuota } from "../lib/quota";
import { fail, ok } from "../lib/response";
import { extractBlockText, extractEntryLinksFromBlocks } from "../lib/tiptap-links";
import { canEdit, canRead, loadWorldAccess, type WorldAccess } from "../lib/world-access";
import { getUser, requireLogin, type AppVariables } from "../middleware/session";
import type { Env } from "../types";

/** entries 表数据行 */
interface EntryRow {
  id: string;
  world_id: string;
  category_id: string;
  title: string;
  cover: string | null;
  tags: string;
  aliases: string;
  protected: number;
  word_count: number;
  version: number;
  last_editor_id: string | null;
  created_at: number;
  updated_at: number;
}

/** entry_blocks 表数据行 */
interface BlockRow {
  id: string;
  entry_id: string;
  sort_order: number;
  title: string;
  content_json: string;
  word_count: number;
  version: number;
  updated_at: number;
}

/** 空文档（TipTap JSON） */
const EMPTY_DOC = '{"type":"doc","content":[]}';

/** 版本快照节流：自动保存不建快照，距上次快照超过该间隔才建 */
const VERSION_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

/** 单个内容块 JSON 长度上限（D1 单行上限 2MB，留足余量） */
const MAX_BLOCK_JSON_LENGTH = 900_000;

/** 保存接口的请求体 */
interface SaveBlocksBody {
  baseVersion?: unknown;
  title?: unknown;
  blocks?: unknown;
  links?: unknown;
  createVersion?: unknown;
  note?: unknown;
}

const entryRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * 加载条目并解析当前用户的权限。
 * @param db D1 数据库
 * @param entryId 条目 id
 * @param userId 当前用户 id（未登录传 null）
 * @returns 条目与所在世界权限；不存在返回 null
 */
async function loadEntryWithAccess(
  db: D1Database,
  entryId: string,
  userId: string | null,
): Promise<{ entry: EntryRow; access: WorldAccess } | null> {
  const entry = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(entryId).first<EntryRow>();
  if (!entry) {
    return null;
  }
  const access = await loadWorldAccess(db, entry.world_id, userId);
  if (!access) {
    return null;
  }
  return { entry, access };
}

/**
 * 条目是否可编辑：具备世界编辑权限；受保护条目额外要求世界管理员及以上。
 * @param access 世界权限
 * @param userId 当前用户 id
 * @param entryProtected 条目是否受保护
 * @returns 可编辑返回 true
 */
function canEditEntry(access: WorldAccess, userId: string | null, entryProtected: boolean): boolean {
  if (!canEdit(access, userId)) {
    return false;
  }
  if (entryProtected) {
    return access.role !== null && hasRoleLevel(access.role, "admin");
  }
  return true;
}

/** 世界条目列表：按分类筛选、标题搜索（需要查看权限） */
entryRoutes.get("/worlds/:worldId/entries", async (c) => {
  const worldId = c.req.param("worldId");
  const userId = c.get("user")?.id ?? null;
  const access = await loadWorldAccess(c.env.DB, worldId, userId);
  if (!access || !canRead(access)) {
    return fail(c, "世界不存在或无权访问", 404);
  }

  const categoryId = c.req.query("categoryId")?.trim() || null;
  const keyword = c.req.query("q")?.trim() || null;

  const result = await c.env.DB.prepare(
    // summary：取第一个内容块的纯文本前 80 字，供列表与画布节点展示摘要用。
    // 这样调用方不必为了拿摘要逐条请求详情（画布每次加载都取摘要，逐条请求会明显变慢）。
    `SELECT e.id, e.title, e.category_id, e.word_count, e.protected, e.updated_at,
            u.name AS lastEditorName,
            (SELECT substr(b.text_content, 1, 80)
               FROM entry_blocks b
              WHERE b.entry_id = e.id
              ORDER BY b.sort_order ASC
              LIMIT 1) AS summary
     FROM entries e
     LEFT JOIN user u ON u.id = e.last_editor_id
     WHERE e.world_id = ?1
       AND (?2 IS NULL OR e.category_id = ?2)
       AND (?3 IS NULL OR e.title LIKE '%' || ?3 || '%')
     ORDER BY e.updated_at DESC
     LIMIT 200`,
  )
    .bind(worldId, categoryId, keyword)
    .all<Record<string, unknown>>();

  return ok(
    c,
    (result.results ?? []).map((row) => ({
      id: row.id as string,
      title: row.title as string,
      categoryId: row.category_id as string,
      wordCount: row.word_count as number,
      protected: Boolean(row.protected),
      updatedAt: row.updated_at as number,
      lastEditorName: (row.lastEditorName as string | null) ?? "",
      summary: (row.summary as string | null)?.trim() ?? "",
    })),
  );
});

/**
 * 创建条目：初始一个空内容块。
 * body: { title, categoryId }
 */
entryRoutes.post("/worlds/:worldId/entries", requireLogin, async (c) => {
  const user = getUser(c);
  const worldId = c.req.param("worldId");
  const access = await loadWorldAccess(c.env.DB, worldId, user.id);
  if (!access) {
    return fail(c, "世界不存在", 404);
  }
  if (!canEdit(access, user.id)) {
    return fail(c, "没有编辑权限", 403);
  }

  let body: { title?: unknown; categoryId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : "";
  const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
  if (!title) {
    return fail(c, "请填写条目标题");
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

  const now = Date.now();
  const entryId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO entries (id, world_id, category_id, title, cover, tags, aliases, protected, word_count, version, last_editor_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, '', '', 0, 0, 1, ?, ?, ?)`,
    ).bind(entryId, worldId, categoryId, title, user.id, now, now),
    c.env.DB.prepare(
      `INSERT INTO entry_blocks (id, entry_id, sort_order, title, content_json, word_count, version, updated_at)
       VALUES (?, ?, 0, '', ?, 0, 1, ?)`,
    ).bind(crypto.randomUUID(), entryId, EMPTY_DOC, now),
    c.env.DB.prepare("UPDATE worlds SET updated_at = ? WHERE id = ?").bind(now, worldId),
  ]);

  return ok(c, { id: entryId }, 201);
});

/** 条目详情：基础信息 + 内容块 + 反向链接 + 当前用户权限 */
entryRoutes.get("/entries/:entryId", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const loaded = await loadEntryWithAccess(c.env.DB, c.req.param("entryId"), userId);
  if (!loaded || !canRead(loaded.access)) {
    return fail(c, "条目不存在或无权访问", 404);
  }
  const { entry, access } = loaded;

  const [blockResult, backlinkResult, world, category, lastEditor] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM entry_blocks WHERE entry_id = ? ORDER BY sort_order ASC")
      .bind(entry.id)
      .all<BlockRow>(),
    c.env.DB.prepare(
      `SELECT DISTINCT e.id, e.title
       FROM entry_links l JOIN entries e ON e.id = l.from_entry_id
       WHERE l.to_entry_id = ?`,
    )
      .bind(entry.id)
      .all<{ id: string; title: string }>(),
    c.env.DB.prepare("SELECT name FROM worlds WHERE id = ?").bind(entry.world_id).first<{ name: string }>(),
    c.env.DB.prepare("SELECT name FROM categories WHERE id = ?").bind(entry.category_id).first<{ name: string }>(),
    entry.last_editor_id
      ? c.env.DB.prepare("SELECT name FROM user WHERE id = ?").bind(entry.last_editor_id).first<{ name: string }>()
      : Promise.resolve(null),
  ]);

  return ok(c, {
    id: entry.id,
    worldId: entry.world_id,
    worldName: world?.name ?? "",
    categoryId: entry.category_id,
    categoryName: category?.name ?? "",
    title: entry.title,
    cover: entry.cover,
    tags: entry.tags,
    aliases: entry.aliases,
    protected: Boolean(entry.protected),
    wordCount: entry.word_count,
    version: entry.version,
    lastEditorName: lastEditor?.name ?? "",
    updatedAt: entry.updated_at,
    createdAt: entry.created_at,
    canEdit: canEditEntry(access, userId, Boolean(entry.protected)),
    myRole: access.role,
    blocks: (blockResult.results ?? []).map((block) => ({
      id: block.id,
      sortOrder: block.sort_order,
      title: block.title,
      contentJson: block.content_json,
      wordCount: block.word_count,
    })),
    backlinks: (backlinkResult.results ?? []).map((row) => ({ id: row.id, title: row.title })),
  });
});

/**
 * 保存内容（自动保存与手动保存共用）。
 * body: { baseVersion, title?, blocks, links, createVersion?, note? }
 * 版本冲突返回 409 与最新版本号。
 */
entryRoutes.put("/entries/:entryId/blocks", requireLogin, async (c) => {
  const user = getUser(c);
  const loaded = await loadEntryWithAccess(c.env.DB, c.req.param("entryId"), user.id);
  if (!loaded) {
    return fail(c, "条目不存在", 404);
  }
  const { entry, access } = loaded;
  if (!canEditEntry(access, user.id, Boolean(entry.protected))) {
    return fail(c, "该条目已受保护，仅管理员可编辑", 403);
  }

  let body: SaveBlocksBody;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }

  const baseVersion = Number(body.baseVersion);
  if (!Number.isInteger(baseVersion)) {
    return fail(c, "缺少版本号");
  }
  if (baseVersion !== entry.version) {
    return c.json(
      { ok: false as const, error: "条目已被他人修改，请刷新后合并", data: { latestVersion: entry.version } },
      409,
    );
  }

  // 入参校验
  const blocks = Array.isArray(body.blocks) ? body.blocks : [];
  if (blocks.length === 0 || blocks.length > 100) {
    return fail(c, "内容块数量不正确");
  }
  const normalizedBlocks = [];
  for (const raw of blocks) {
    const item = raw as { title?: unknown; contentJson?: unknown; wordCount?: unknown };
    const contentJson = typeof item.contentJson === "string" ? item.contentJson : "";
    if (!contentJson || contentJson.length > MAX_BLOCK_JSON_LENGTH) {
      return fail(c, "内容过长或格式不正确");
    }
    normalizedBlocks.push({
      title: typeof item.title === "string" ? item.title.slice(0, 120) : "",
      contentJson,
      wordCount: Math.max(Number(item.wordCount) || 0, 0),
    });
  }

  const links = Array.isArray(body.links) ? body.links : [];
  const normalizedLinks = [];
  const seenTargets = new Set<string>();
  for (const raw of links) {
    const item = raw as { toEntryId?: unknown; toTitle?: unknown };
    const toEntryId = typeof item.toEntryId === "string" ? item.toEntryId : "";
    const toTitle = typeof item.toTitle === "string" ? item.toTitle.slice(0, 120) : "";
    if (!toEntryId || seenTargets.has(toEntryId)) {
      continue;
    }
    seenTargets.add(toEntryId);
    normalizedLinks.push({ toEntryId, toTitle });
  }

  const newTitle = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 100) : null;
  const createVersion = body.createVersion === true;
  const note = typeof body.note === "string" ? body.note.slice(0, 100) : "";

  if (!(await checkNewAccountQuota(c.env.DB, user))) {
    return fail(c, "新账号每日编辑次数已达上限，请明天再试", 429);
  }

  const now = Date.now();
  const newVersion = entry.version + 1;
  const totalWords = normalizedBlocks.reduce((sum, block) => sum + block.wordCount, 0);

  // 是否创建版本快照：手动保存、首次保存、或距上次快照超过节流间隔
  const lastSnapshot = await c.env.DB.prepare(
    "SELECT created_at FROM entry_versions WHERE entry_id = ? ORDER BY version DESC LIMIT 1",
  )
    .bind(entry.id)
    .first<{ created_at: number }>();
  const shouldSnapshot =
    createVersion || !lastSnapshot || now - lastSnapshot.created_at >= VERSION_SNAPSHOT_INTERVAL_MS;

  const statements = [
    c.env.DB.prepare("DELETE FROM entry_blocks WHERE entry_id = ?").bind(entry.id),
    ...normalizedBlocks.map((block, index) =>
      c.env.DB.prepare(
        `INSERT INTO entry_blocks (id, entry_id, sort_order, title, content_json, text_content, word_count, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        entry.id,
        index,
        block.title,
        block.contentJson,
        extractBlockText(block.contentJson),
        block.wordCount,
        newVersion,
        now,
      ),
    ),
    c.env.DB.prepare("DELETE FROM entry_links WHERE from_entry_id = ?").bind(entry.id),
    ...normalizedLinks.map((link) =>
      c.env.DB.prepare(
        "INSERT INTO entry_links (id, from_entry_id, to_entry_id, to_title, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), entry.id, link.toEntryId, link.toTitle, now),
    ),
    c.env.DB.prepare(
      `UPDATE entries SET title = COALESCE(?, title), word_count = ?, version = ?, last_editor_id = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(newTitle, totalWords, newVersion, user.id, now, entry.id),
    c.env.DB.prepare("UPDATE worlds SET updated_at = ? WHERE id = ?").bind(now, entry.world_id),
  ];

  if (shouldSnapshot) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO entry_versions (id, entry_id, version, changed_blocks, editor_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        entry.id,
        newVersion,
        JSON.stringify(normalizedBlocks),
        user.id,
        note || (createVersion ? "手动保存" : "自动保存"),
        now,
      ),
    );
  }

  await c.env.DB.batch(statements);

  return ok(c, { version: newVersion, savedAt: now, snapshot: shouldSnapshot });
});

/** 条目历史版本列表（最近 50 条） */
entryRoutes.get("/entries/:entryId/versions", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const loaded = await loadEntryWithAccess(c.env.DB, c.req.param("entryId"), userId);
  if (!loaded || !canRead(loaded.access)) {
    return fail(c, "条目不存在或无权访问", 404);
  }

  const result = await c.env.DB.prepare(
    `SELECT v.version, v.note, v.created_at, u.name AS editorName
     FROM entry_versions v
     LEFT JOIN user u ON u.id = v.editor_id
     WHERE v.entry_id = ?
     ORDER BY v.version DESC
     LIMIT 50`,
  )
    .bind(loaded.entry.id)
    .all<Record<string, unknown>>();

  return ok(
    c,
    (result.results ?? []).map((row) => ({
      version: row.version as number,
      note: row.note as string,
      editorName: (row.editorName as string | null) ?? "",
      createdAt: row.created_at as number,
    })),
  );
});

/** 历史版本内容（用于预览） */
entryRoutes.get("/entries/:entryId/versions/:version", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const loaded = await loadEntryWithAccess(c.env.DB, c.req.param("entryId"), userId);
  if (!loaded || !canRead(loaded.access)) {
    return fail(c, "条目不存在或无权访问", 404);
  }

  const versionNumber = Number(c.req.param("version"));
  const row = await c.env.DB.prepare(
    "SELECT changed_blocks FROM entry_versions WHERE entry_id = ? AND version = ?",
  )
    .bind(loaded.entry.id, versionNumber)
    .first<{ changed_blocks: string }>();
  if (!row) {
    return fail(c, "版本不存在", 404);
  }

  try {
    return ok(c, { version: versionNumber, blocks: JSON.parse(row.changed_blocks) });
  } catch {
    return fail(c, "版本数据损坏", 500);
  }
});

/** 回滚到指定历史版本：以旧内容生成新版本，不删除历史 */
entryRoutes.post("/entries/:entryId/versions/:version/rollback", requireLogin, async (c) => {
  const user = getUser(c);
  const loaded = await loadEntryWithAccess(c.env.DB, c.req.param("entryId"), user.id);
  if (!loaded) {
    return fail(c, "条目不存在", 404);
  }
  const { entry, access } = loaded;
  if (!canEditEntry(access, user.id, Boolean(entry.protected))) {
    return fail(c, "该条目已受保护，仅管理员可编辑", 403);
  }

  const versionNumber = Number(c.req.param("version"));
  const row = await c.env.DB.prepare(
    "SELECT changed_blocks FROM entry_versions WHERE entry_id = ? AND version = ?",
  )
    .bind(entry.id, versionNumber)
    .first<{ changed_blocks: string }>();
  if (!row) {
    return fail(c, "版本不存在", 404);
  }

  let blocks: Array<{ title: string; contentJson: string; wordCount: number }>;
  try {
    blocks = JSON.parse(row.changed_blocks);
  } catch {
    return fail(c, "版本数据损坏", 500);
  }
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return fail(c, "版本数据损坏", 500);
  }

  if (!(await checkNewAccountQuota(c.env.DB, user))) {
    return fail(c, "新账号每日编辑次数已达上限，请明天再试", 429);
  }

  const now = Date.now();
  const newVersion = entry.version + 1;
  const totalWords = blocks.reduce((sum, block) => sum + (Number(block.wordCount) || 0), 0);

  // 从恢复的内容块中解析条目关联，重建 entry_links（与正文保持一致）
  const restoredLinks = extractEntryLinksFromBlocks(blocks);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM entry_blocks WHERE entry_id = ?").bind(entry.id),
    ...blocks.map((block, index) =>
      c.env.DB.prepare(
        `INSERT INTO entry_blocks (id, entry_id, sort_order, title, content_json, text_content, word_count, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        entry.id,
        index,
        block.title ?? "",
        block.contentJson,
        extractBlockText(block.contentJson),
        block.wordCount ?? 0,
        newVersion,
        now,
      ),
    ),
    c.env.DB.prepare("DELETE FROM entry_links WHERE from_entry_id = ?").bind(entry.id),
    ...restoredLinks.map((link) =>
      c.env.DB.prepare(
        "INSERT INTO entry_links (id, from_entry_id, to_entry_id, to_title, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), entry.id, link.toEntryId, link.toTitle, now),
    ),
    c.env.DB.prepare(
      "UPDATE entries SET word_count = ?, version = ?, last_editor_id = ?, updated_at = ? WHERE id = ?",
    ).bind(totalWords, newVersion, user.id, now, entry.id),
    c.env.DB.prepare(
      `INSERT INTO entry_versions (id, entry_id, version, changed_blocks, editor_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), entry.id, newVersion, JSON.stringify(blocks), user.id, `回滚到版本 v${versionNumber}`, now),
  ]);

  return ok(c, { version: newVersion });
});

/** 设置 / 取消条目保护（世界管理员及以上） */
entryRoutes.post("/entries/:entryId/protect", requireLogin, async (c) => {
  const user = getUser(c);
  const loaded = await loadEntryWithAccess(c.env.DB, c.req.param("entryId"), user.id);
  if (!loaded) {
    return fail(c, "条目不存在", 404);
  }
  const { entry, access } = loaded;
  if (!access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "需要世界管理员权限", 403);
  }

  let body: { protected?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }
  if (typeof body.protected !== "boolean") {
    return fail(c, "参数不正确");
  }

  await c.env.DB.prepare("UPDATE entries SET protected = ?, updated_at = ? WHERE id = ?")
    .bind(body.protected ? 1 : 0, Date.now(), entry.id)
    .run();
  return ok(c, { protected: body.protected });
});

/** 删除条目（世界管理员及以上）及其块、链接、历史 */
entryRoutes.delete("/entries/:entryId", requireLogin, async (c) => {
  const user = getUser(c);
  const loaded = await loadEntryWithAccess(c.env.DB, c.req.param("entryId"), user.id);
  if (!loaded) {
    return fail(c, "条目不存在", 404);
  }
  const { entry, access } = loaded;
  if (!access.role || !hasRoleLevel(access.role, "admin")) {
    return fail(c, "删除条目需要世界管理员权限", 403);
  }

  await deleteEntryCascade(c.env.DB, entry.id);
  await c.env.DB.prepare("UPDATE worlds SET updated_at = ? WHERE id = ?").bind(Date.now(), entry.world_id).run();

  return ok(c, { deleted: true });
});

/**
 * 生成命中片段：命中词两侧各截取 30 字。
 * @param text 被搜索的文本
 * @param keyword 搜索词
 * @returns 摘要片段
 */
function buildSnippet(text: string, keyword: string): string {
  const index = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (index < 0) {
    return text.slice(0, 60);
  }
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + keyword.length + 30);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * 全文搜索：标题 + 正文纯文本，支持分类筛选（需要查看权限）。
 * query: q（必填）、categoryId（可选）
 */
entryRoutes.get("/worlds/:worldId/search", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const access = await loadWorldAccess(c.env.DB, c.req.param("worldId"), userId);
  if (!access || !canRead(access)) {
    return fail(c, "世界不存在或无权访问", 404);
  }

  const keyword = c.req.query("q")?.trim() ?? "";
  if (!keyword) {
    return fail(c, "请输入搜索关键词");
  }
  const categoryId = c.req.query("categoryId")?.trim() || null;

  // 转义 LIKE 通配符，避免用户输入 % / _ 影响匹配
  const escaped = keyword.replace(/[\\%_]/g, (char) => `\\${char}`);

  const result = await c.env.DB.prepare(
    `SELECT e.id, e.title, e.category_id, e.updated_at,
            (SELECT b.text_content FROM entry_blocks b
             WHERE b.entry_id = e.id AND b.text_content LIKE '%' || ?1 || '%' ESCAPE '\\'
             LIMIT 1) AS matched_text
     FROM entries e
     WHERE e.world_id = ?2
       AND (?3 IS NULL OR e.category_id = ?3)
       AND (
         e.title LIKE '%' || ?1 || '%' ESCAPE '\\'
         OR EXISTS (SELECT 1 FROM entry_blocks b2 WHERE b2.entry_id = e.id AND b2.text_content LIKE '%' || ?1 || '%' ESCAPE '\\')
       )
     ORDER BY e.updated_at DESC
     LIMIT 50`,
  )
    .bind(escaped, access.world.id, categoryId)
    .all<Record<string, unknown>>();

  return ok(
    c,
    (result.results ?? []).map((row) => {
      const title = row.title as string;
      const matchedText = (row.matched_text as string | null) ?? "";
      const titleHit = title.toLowerCase().includes(keyword.toLowerCase());
      return {
        id: row.id as string,
        title,
        categoryId: row.category_id as string,
        updatedAt: row.updated_at as number,
        snippet: buildSnippet(titleHit ? title : matchedText || title, keyword),
        matchedIn: titleHit ? "title" : "content",
      };
    }),
  );
});

export default entryRoutes;
