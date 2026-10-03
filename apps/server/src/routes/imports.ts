import { Hono } from "hono";
import { countWords } from "@create-world/core";
import { deleteWorldCascade } from "../lib/delete-cascade";
import { fail, ok } from "../lib/response";
import { extractBlockText } from "../lib/tiptap-links";
import { getUser, requireLogin, type AppVariables } from "../middleware/session";
import type { Env } from "../types";

/** 导入格式标识与版本（与本项目「导出 JSON」一一对应） */
const IMPORT_FORMAT = "create-world-export";
const IMPORT_VERSION = 1;

/** 导入上限（见 docs/方案.md 12.2） */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_BLOCKS = 5000;

/** 每账号每天的导入次数上限 */
const MAX_IMPORTS_PER_DAY = 3;

/** 写库时分批提交的语句数（控制单次 batch 大小） */
const BATCH_CHUNK_SIZE = 40;

/** 合法的世界可见性 */
const VISIBILITIES = new Set(["private", "public_read", "public_edit"]);

/** 导入文件（宽松结构，逐字段校验） */
interface ImportPayload {
  format?: unknown;
  version?: unknown;
  world?: { name?: unknown; intro?: unknown; visibility?: unknown };
  categories?: Array<{ id?: unknown; name?: unknown }>;
  tags?: unknown[];
  entries?: Array<{
    id?: unknown;
    title?: unknown;
    categoryId?: unknown;
    tags?: unknown;
    aliases?: unknown;
    blocks?: unknown[];
  }>;
  links?: Array<{ fromEntryId?: unknown; toEntryId?: unknown; toTitle?: unknown }>;
  eras?: Array<{ id?: unknown; name?: unknown; sortOrder?: unknown }>;
  events?: Array<Record<string, unknown>>;
  maps?: unknown[];
}

const importRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * 把块数组规范化为 TipTap 文档 JSON 字符串数组。
 * @param raw 文件中的 blocks 字段
 * @returns 序列化后的内容块列表
 */
function normalizeBlocks(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((block) => block !== null && typeof block === "object")
    .map((block) => JSON.stringify(block));
}

/**
 * JSON 导入为新世界（Phase 1）。
 * body: multipart/form-data —— file（导出的 JSON）+ 可选 name（覆盖世界名）。
 */
importRoutes.post("/imports", requireLogin, async (c) => {
  const user = getUser(c);

  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail(c, "请选择要导入的 JSON 文件");
  }
  if (file.size > MAX_FILE_BYTES) {
    return fail(c, "文件超过 20MB 上限");
  }

  let data: ImportPayload;
  try {
    data = JSON.parse(await file.text()) as ImportPayload;
  } catch {
    return fail(c, "文件不是有效的 JSON");
  }
  if (data?.format !== IMPORT_FORMAT || data?.version !== IMPORT_VERSION) {
    return fail(c, "格式不支持：请使用本站「世界设置 → 导出 JSON」生成的文件");
  }

  const entries = Array.isArray(data.entries) ? data.entries : [];
  const totalBlocks = entries.reduce(
    (sum, entry) => sum + (Array.isArray(entry?.blocks) ? entry.blocks.length : 0),
    0,
  );
  if (entries.length > MAX_ENTRIES || totalBlocks > MAX_BLOCKS) {
    return fail(c, `超出导入上限（最多 ${MAX_ENTRIES} 条目 / ${MAX_BLOCKS} 内容块）`);
  }

  // 频次限额：每账号每天最多 3 次
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const used = await c.env.DB.prepare(
    "SELECT COUNT(*) AS total FROM import_logs WHERE user_id = ? AND created_at >= ?",
  )
    .bind(user.id, dayStart.getTime())
    .first<{ total: number }>();
  if ((used?.total ?? 0) >= MAX_IMPORTS_PER_DAY) {
    return fail(c, "今日导入次数已达上限（每天 3 次），请明天再试", 429);
  }

  const now = Date.now();
  const logId = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO import_logs (id, user_id, status, created_at) VALUES (?, ?, 'processing', ?)")
    .bind(logId, user.id, now)
    .run();

  // 世界基本信息（名称允许被表单覆盖）
  const nameOverride = form?.get("name");
  const worldName = (
    typeof nameOverride === "string" && nameOverride.trim()
      ? nameOverride.trim()
      : String(data.world?.name ?? "导入的世界")
  ).slice(0, 60);
  const intro = typeof data.world?.intro === "string" ? data.world.intro.slice(0, 500) : "";
  const visibility = VISIBILITIES.has(String(data.world?.visibility))
    ? (data.world?.visibility as string)
    : "private";
  const worldId = crypto.randomUUID();

  try {
    // 分批写入，避免单次 batch 过大
    let pending: D1PreparedStatement[] = [];
    const flush = async () => {
      if (pending.length > 0) {
        await c.env.DB.batch(pending);
        pending = [];
      }
    };
    const push = async (statement: D1PreparedStatement) => {
      pending.push(statement);
      if (pending.length >= BATCH_CHUNK_SIZE) {
        await flush();
      }
    };

    // 世界 + 创建者成员
    await push(
      c.env.DB.prepare(
        "INSERT INTO worlds (id, owner_id, name, intro, cover, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
      ).bind(worldId, user.id, worldName, intro, visibility, now, now),
    );
    await push(
      c.env.DB.prepare(
        "INSERT INTO world_members (world_id, user_id, role, source, joined_at) VALUES (?, ?, 'owner', 'invite', ?)",
      ).bind(worldId, user.id, now),
    );

    // 分类：建立 旧 id → 新 id 映射
    const categoryIdMap = new Map<string, string>();
    let categoryCount = 0;
    for (const category of data.categories ?? []) {
      const categoryName = typeof category?.name === "string" ? category.name.trim().slice(0, 20) : "";
      if (!categoryName) {
        continue;
      }
      const newId = crypto.randomUUID();
      if (typeof category?.id === "string") {
        categoryIdMap.set(category.id, newId);
      }
      await push(
        c.env.DB.prepare(
          "INSERT INTO categories (id, world_id, name, icon, color, sort_order) VALUES (?, ?, ?, NULL, NULL, ?)",
        ).bind(newId, worldId, categoryName, categoryCount),
      );
      categoryCount += 1;
    }

    // 世界标签：只关联标签库中已存在的标签
    for (const tagName of data.tags ?? []) {
      if (typeof tagName === "string" && tagName) {
        await push(
          c.env.DB.prepare(
            "INSERT INTO world_tags (world_id, tag_id) SELECT ?, id FROM tags WHERE name = ? AND status = 'active'",
          ).bind(worldId, tagName),
        );
      }
    }

    // 兜底分类：条目引用的分类缺失时使用
    let fallbackCategoryId: string | null = null;
    const ensureFallbackCategory = async (): Promise<string> => {
      if (!fallbackCategoryId) {
        fallbackCategoryId = crypto.randomUUID();
        await push(
          c.env.DB.prepare(
            "INSERT INTO categories (id, world_id, name, icon, color, sort_order) VALUES (?, ?, '未分类', NULL, NULL, ?)",
          ).bind(fallbackCategoryId, worldId, categoryCount),
        );
        categoryCount += 1;
      }
      return fallbackCategoryId;
    };

    // 条目与内容块：建立 旧 id → 新 id 映射与标题索引（供链接解析）
    const entryIdMap = new Map<string, string>();
    const entryIdByTitle = new Map<string, string>();
    let importedEntries = 0;
    for (const entry of entries) {
      const title = typeof entry?.title === "string" ? entry.title.trim().slice(0, 100) : "";
      if (!title) {
        continue;
      }
      const mappedCategory =
        (typeof entry?.categoryId === "string" ? categoryIdMap.get(entry.categoryId) : undefined) ??
        (await ensureFallbackCategory());

      const blockJsons = normalizeBlocks(entry.blocks);
      const blockTexts = blockJsons.map((json) => extractBlockText(json));
      const entryWords = blockTexts.reduce((sum, text) => sum + countWords(text), 0);

      const newEntryId = crypto.randomUUID();
      if (typeof entry?.id === "string") {
        entryIdMap.set(entry.id, newEntryId);
      }
      entryIdByTitle.set(title.toLowerCase(), newEntryId);

      await push(
        c.env.DB.prepare(
          `INSERT INTO entries (id, world_id, category_id, title, cover, tags, aliases, protected, word_count, version, last_editor_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, 0, ?, 1, ?, ?, ?)`,
        ).bind(
          newEntryId,
          worldId,
          mappedCategory,
          title,
          typeof entry?.tags === "string" ? entry.tags.slice(0, 200) : "",
          typeof entry?.aliases === "string" ? entry.aliases.slice(0, 200) : "",
          entryWords,
          user.id,
          now,
          now,
        ),
      );

      const blocksToWrite = blockJsons.length > 0 ? blockJsons : ['{"type":"doc","content":[]}'];
      for (let index = 0; index < blocksToWrite.length; index += 1) {
        const contentJson = blocksToWrite[index] as string;
        const textContent = blockTexts[index] ?? extractBlockText(contentJson);
        await push(
          c.env.DB.prepare(
            `INSERT INTO entry_blocks (id, entry_id, sort_order, title, content_json, text_content, word_count, version, updated_at)
             VALUES (?, ?, ?, '', ?, ?, ?, 1, ?)`,
          ).bind(
            crypto.randomUUID(),
            newEntryId,
            index,
            contentJson,
            textContent,
            countWords(textContent),
            now,
          ),
        );
      }
      importedEntries += 1;
    }

    // 条目关联：优先按 id 映射，缺失时按标题匹配
    let linkCount = 0;
    for (const link of data.links ?? []) {
      const fromId = typeof link?.fromEntryId === "string" ? entryIdMap.get(link.fromEntryId) : undefined;
      if (!fromId) {
        continue;
      }
      let toId: string | undefined;
      if (typeof link?.toEntryId === "string" && link.toEntryId) {
        toId = entryIdMap.get(link.toEntryId);
      }
      if (!toId && typeof link?.toTitle === "string") {
        toId = entryIdByTitle.get(link.toTitle.toLowerCase());
      }
      if (!toId) {
        continue;
      }
      await push(
        c.env.DB.prepare(
          "INSERT INTO entry_links (id, from_entry_id, to_entry_id, to_title, created_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(
          crypto.randomUUID(),
          fromId,
          toId,
          typeof link?.toTitle === "string" ? link.toTitle.slice(0, 120) : "",
          now,
        ),
      );
      linkCount += 1;
    }

    // 纪元与事件
    const eraIdMap = new Map<string, string>();
    for (const era of data.eras ?? []) {
      const eraName = typeof era?.name === "string" ? era.name.trim().slice(0, 30) : "";
      if (!eraName) {
        continue;
      }
      const newEraId = crypto.randomUUID();
      if (typeof era?.id === "string") {
        eraIdMap.set(era.id, newEraId);
      }
      await push(
        c.env.DB.prepare("INSERT INTO eras (id, world_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)").bind(
          newEraId,
          worldId,
          eraName,
          Number.isInteger(Number(era?.sortOrder)) ? Number(era?.sortOrder) : eraIdMap.size,
          now,
        ),
      );
    }
    for (const event of data.events ?? []) {
      const title = typeof event?.title === "string" ? event.title.trim().slice(0, 120) : "";
      if (!title) {
        continue;
      }
      const undetermined = event?.timeUndetermined === true;
      const mappedEra =
        !undetermined && typeof event?.eraId === "string" ? eraIdMap.get(event.eraId) ?? null : null;
      const mappedEntry =
        typeof event?.entryId === "string" ? entryIdMap.get(event.entryId) ?? null : null;
      await push(
        c.env.DB.prepare(
          `INSERT INTO timeline_events
             (id, world_id, title, description, era_id, year, month, day, season, time_undetermined, entry_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          worldId,
          title,
          typeof event?.description === "string" ? event.description.slice(0, 2000) : "",
          mappedEra,
          undetermined ? null : Number.isInteger(Number(event?.year)) ? Number(event?.year) : null,
          undetermined ? null : Number.isInteger(Number(event?.month)) ? Number(event?.month) : null,
          undetermined ? null : Number.isInteger(Number(event?.day)) ? Number(event?.day) : null,
          typeof event?.season === "string" ? event.season.slice(0, 20) : "",
          undetermined ? 1 : 0,
          mappedEntry,
          user.id,
          now,
          now,
        ),
      );
    }

    await flush();

    // 完成：登记导入结果
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE import_logs SET status = 'success', world_id = ?, entries_count = ? WHERE id = ?")
        .bind(worldId, importedEntries, logId),
      c.env.DB.prepare("UPDATE worlds SET updated_at = ? WHERE id = ?").bind(Date.now(), worldId),
    ]);

    const skippedMaps = Array.isArray(data.maps) ? data.maps.length : 0;
    return ok(
      c,
      { worldId, entries: importedEntries, categories: categoryCount, links: linkCount, skippedMaps },
      201,
    );
  } catch (error) {
    // 失败清理：删除半成品世界并记录失败
    await deleteWorldCascade(c.env.DB, worldId).catch(() => undefined);
    await c.env.DB.prepare("UPDATE import_logs SET status = 'failed' WHERE id = ?")
      .bind(logId)
      .run()
      .catch(() => undefined);
    console.error("导入失败：", error);
    return fail(c, "导入失败，请检查文件内容后重试", 500);
  }
});

export default importRoutes;
