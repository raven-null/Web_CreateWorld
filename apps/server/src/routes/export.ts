import { Hono } from "hono";
import { strToU8, zipSync } from "fflate";
import { formatEventTime, type TimeGranularity, type TimeNumberStyle } from "@create-world/core";
import { fail } from "../lib/response";
import { tipTapToMarkdown } from "../lib/tiptap-markdown";
import { canRead, loadWorldAccess } from "../lib/world-access";
import type { AppVariables } from "../middleware/session";
import type { Env } from "../types";

/** entries 表数据行（导出用） */
interface EntryRow {
  id: string;
  category_id: string;
  title: string;
  tags: string;
  aliases: string;
  protected: number;
  word_count: number;
  created_at: number;
  updated_at: number;
}

const exportRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * 汇总世界的全部导出数据。
 * @param db D1 数据库
 * @param worldId 世界 id
 * @returns 结构化导出数据
 */
async function collectWorldData(db: D1Database, worldId: string) {
  const [world, worldConfig, categories, tags, entries, blocks, links, eras, events, maps, markers] =
    await Promise.all([
      db.prepare("SELECT * FROM worlds WHERE id = ?").bind(worldId).first<Record<string, unknown>>(),
      db
        .prepare("SELECT time_granularity, time_number_style FROM worlds WHERE id = ?")
        .bind(worldId)
        .first<{ time_granularity: TimeGranularity; time_number_style: TimeNumberStyle }>(),
      db.prepare("SELECT id, name, icon, color, sort_order FROM categories WHERE world_id = ? ORDER BY sort_order")
        .bind(worldId)
        .all<Record<string, unknown>>(),
      db
        .prepare("SELECT t.name FROM world_tags wt JOIN tags t ON t.id = wt.tag_id WHERE wt.world_id = ? ORDER BY t.sort_order")
        .bind(worldId)
        .all<{ name: string }>(),
      db.prepare("SELECT * FROM entries WHERE world_id = ? ORDER BY updated_at DESC").bind(worldId).all<EntryRow>(),
      db
        .prepare(
          `SELECT b.entry_id, b.content_json FROM entry_blocks b
           JOIN entries e ON e.id = b.entry_id
           WHERE e.world_id = ? ORDER BY b.sort_order`,
        )
        .bind(worldId)
        .all<{ entry_id: string; content_json: string }>(),
      db
        .prepare(
          `SELECT l.from_entry_id, l.to_entry_id, l.to_title FROM entry_links l
           JOIN entries e ON e.id = l.from_entry_id WHERE e.world_id = ?`,
        )
        .bind(worldId)
        .all<{ from_entry_id: string; to_entry_id: string | null; to_title: string }>(),
      db.prepare("SELECT id, name, sort_order FROM eras WHERE world_id = ? ORDER BY sort_order").bind(worldId)
        .all<{ id: string; name: string; sort_order: number }>(),
      db.prepare("SELECT * FROM timeline_events WHERE world_id = ?").bind(worldId).all<Record<string, unknown>>(),
      db.prepare("SELECT id, name FROM maps WHERE world_id = ? ORDER BY created_at").bind(worldId)
        .all<{ id: string; name: string }>(),
      db
        .prepare(
          `SELECT k.map_id, k.x, k.y, k.label, k.entry_id, e.title AS entryTitle
           FROM markers k LEFT JOIN entries e ON e.id = k.entry_id
           WHERE k.map_id IN (SELECT id FROM maps WHERE world_id = ?)`,
        )
        .bind(worldId)
        .all<Record<string, unknown>>(),
    ]);

  // 合并每个条目的内容块
  const blocksByEntry = new Map<string, Array<{ contentJson: string }>>();
  for (const block of blocks.results ?? []) {
    const list = blocksByEntry.get(block.entry_id) ?? [];
    list.push({ contentJson: block.content_json });
    blocksByEntry.set(block.entry_id, list);
  }

  return {
    // 导入功能依赖的格式标识与版本（勿随意修改，见 docs/方案.md 12.2）
    format: "create-world-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    world: {
      id: world?.id,
      name: world?.name,
      intro: world?.intro,
      visibility: world?.visibility,
      createdAt: world?.created_at,
    },
    timeConfig: {
      granularity: worldConfig?.time_granularity ?? "day",
      numberStyle: worldConfig?.time_number_style ?? "arabic",
    },
    categories: (categories.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      sortOrder: row.sort_order,
    })),
    tags: (tags.results ?? []).map((row) => row.name),
    entries: (entries.results ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      categoryId: entry.category_id,
      tags: entry.tags,
      aliases: entry.aliases,
      protected: Boolean(entry.protected),
      wordCount: entry.word_count,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
      blocks: (blocksByEntry.get(entry.id) ?? []).map((block) => JSON.parse(block.contentJson)),
    })),
    links: (links.results ?? []).map((row) => ({
      fromEntryId: row.from_entry_id,
      toEntryId: row.to_entry_id,
      toTitle: row.to_title,
    })),
    eras: (eras.results ?? []).map((row) => ({ id: row.id, name: row.name, sortOrder: row.sort_order })),
    events: (events.results ?? []).map((row) => ({
      title: row.title,
      description: row.description,
      eraId: row.era_id,
      year: row.year,
      month: row.month,
      day: row.day,
      season: row.season,
      timeUndetermined: Boolean(row.time_undetermined),
      entryId: row.entry_id,
    })),
    maps: (maps.results ?? []).map((map) => ({
      id: map.id,
      name: map.name,
      markers: (markers.results ?? [])
        .filter((marker) => marker.map_id === map.id)
        .map((marker) => ({
          x: marker.x,
          y: marker.y,
          label: marker.label,
          entryId: marker.entry_id,
          entryTitle: marker.entryTitle,
        })),
    })),
  };
}

/**
 * 文件名安全化：替换非法字符并去重。
 * @param name 原始名称
 * @param used 已使用文件名集合
 * @returns 安全文件名（不含扩展名）
 */
function safeFileName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/:*?"<>|\n\r]/g, "_").trim().slice(0, 60) || "未命名";
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

/** 世界数据 JSON 导出（完整备份，含内容块与元数据） */
exportRoutes.get("/worlds/:worldId/export/json", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const access = await loadWorldAccess(c.env.DB, c.req.param("worldId"), userId);
  if (!access || !canRead(access)) {
    return fail(c, "世界不存在或无权访问", 404);
  }

  const data = await collectWorldData(c.env.DB, access.world.id);
  const fileName = `${access.world.name.replace(/[\\/:*?"<>|\n\r]/g, "_").slice(0, 50)}.json`;

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="world.json"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  });
});

/** 世界 Markdown 导出（zip：world.md + entries/… + timeline.md + maps.md） */
exportRoutes.get("/worlds/:worldId/export/markdown", async (c) => {
  const userId = c.get("user")?.id ?? null;
  const access = await loadWorldAccess(c.env.DB, c.req.param("worldId"), userId);
  if (!access || !canRead(access)) {
    return fail(c, "世界不存在或无权访问", 404);
  }

  const data = await collectWorldData(c.env.DB, access.world.id);
  const entryTitleById = new Map(data.entries.map((entry) => [entry.id, entry.title]));
  const categoryNameById = new Map(data.categories.map((category) => [category.id as string, category.name as string]));

  // 反向链接索引：目标条目 → 来源条目标题列表
  const backlinks = new Map<string, string[]>();
  for (const link of data.links) {
    if (!link.toEntryId) {
      continue;
    }
    const fromTitle = entryTitleById.get(link.fromEntryId) ?? "未知条目";
    const list = backlinks.get(link.toEntryId) ?? [];
    list.push(fromTitle);
    backlinks.set(link.toEntryId, list);
  }

  const files: Record<string, Uint8Array> = {};
  const usedFileNames = new Set<string>();
  const worldName = String(data.world.name ?? "world");

  // 世界索引
  const indexLines: string[] = [`# ${worldName}`, ""];
  if (data.world.intro) {
    indexLines.push(String(data.world.intro), "");
  }
  for (const category of data.categories) {
    indexLines.push(`## ${category.name}`, "");
    const categoryEntries = data.entries.filter((entry) => entry.categoryId === category.id);
    for (const entry of categoryEntries) {
      indexLines.push(`- [[${entry.title}]]`);
    }
    indexLines.push("");
  }
  files["world.md"] = strToU8(indexLines.join("\n"));

  // 各条目文件
  for (const entry of data.entries) {
    const categoryName = categoryNameById.get(entry.categoryId) ?? "未分类";
    const fileName = safeFileName(entry.title, usedFileNames);
    const doc = entry.blocks[0] as { type?: string; content?: unknown[] } | undefined;
    const body = doc ? tipTapToMarkdown(doc as never, entryTitleById) : "";

    const lines: string[] = [`# ${entry.title}`, ""];
    lines.push(`> 分类：${categoryName}${entry.tags ? ` · 标签：${entry.tags}` : ""}`);
    lines.push("");
    if (body) {
      lines.push(body, "");
    }
    const back = backlinks.get(entry.id) ?? [];
    if (back.length > 0) {
      lines.push("## 反向链接", "");
      for (const title of back) {
        lines.push(`- [[${title}]]`);
      }
      lines.push("");
    }
    files[`entries/${categoryName}/${fileName}.md`] = strToU8(lines.join("\n"));
  }

  // 时间线
  if (data.eras.length > 0 || data.events.length > 0) {
    const eraNameById = new Map(data.eras.map((era) => [era.id, era.name]));
    const timelineLines: string[] = ["# 时间线", ""];
    for (const era of data.eras) {
      timelineLines.push(`## ${era.name}`, "");
      const eraEvents = data.events
        .filter((event) => !event.timeUndetermined && event.eraId === era.id)
        .sort(
          (a, b) =>
            (Number(a.year) || 0) - (Number(b.year) || 0) ||
            (Number(a.month) || 0) - (Number(b.month) || 0) ||
            (Number(a.day) || 0) - (Number(b.day) || 0),
        );
      for (const event of eraEvents) {
        const time = formatEventTime({
          eraName: eraNameById.get(event.eraId as string) ?? null,
          year: event.year as number | null,
          month: event.month as number | null,
          day: event.day as number | null,
          season: String(event.season ?? ""),
          timeUndetermined: false,
          granularity: data.timeConfig.granularity,
          numberStyle: data.timeConfig.numberStyle,
        });
        const entryLink = event.entryId ? ` → [[${entryTitleById.get(String(event.entryId)) ?? "关联条目"}]]` : "";
        timelineLines.push(`- **${time}** ${event.title}${entryLink}`);
        if (event.description) {
          timelineLines.push(`  ${String(event.description).replace(/\n/g, " ")}`);
        }
      }
      timelineLines.push("");
    }
    const undetermined = data.events.filter((event) => event.timeUndetermined);
    if (undetermined.length > 0) {
      timelineLines.push("## 时间未定", "");
      for (const event of undetermined) {
        timelineLines.push(`- ${event.title}`);
      }
      timelineLines.push("");
    }
    files["timeline.md"] = strToU8(timelineLines.join("\n"));
  }

  // 地图
  if (data.maps.length > 0) {
    const mapLines: string[] = ["# 地图", ""];
    for (const map of data.maps) {
      mapLines.push(`## ${map.name}`, "");
      for (const marker of map.markers) {
        const position = `(${Math.round(Number(marker.x) * 100)}%, ${Math.round(Number(marker.y) * 100)}%)`;
        const entryLink = marker.entryId ? ` → [[${marker.entryTitle ?? "关联条目"}]]` : "";
        mapLines.push(`- ${marker.label || "标记"} ${position}${entryLink}`);
      }
      mapLines.push("");
    }
    files["maps.md"] = strToU8(mapLines.join("\n"));
  }

  const zipped = zipSync(files, { level: 6 });
  const zipName = `${worldName.replace(/[\\/:*?"<>|\n\r]/g, "_").slice(0, 50)}-markdown.zip`;
  return new Response(zipped, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="world-markdown.zip"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    },
  });
});

export default exportRoutes;
