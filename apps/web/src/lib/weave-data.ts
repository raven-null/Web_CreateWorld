/**
 * 画布数据层：数据库结构 ↔ Weave 存档之间的转换与差异比较。
 *
 * 映射约定（全项目统一）：
 *   条目 category  → 画布分区（分类就是画布）
 *   条目标题/摘要  → 节点标题/描述
 *   条目关联       → 连线
 *   条目正文       → 仍在条目页用 TipTap 编辑（画布只做结构与关联）
 */
import type { WeaveNode, WeavePayload, WeaveRegion } from "./weave-store";

/** 世界信息（分类与名称） */
export interface WorldInfo {
  id: string;
  name: string;
  categories: Array<{ id: string; name: string; color: string | null }>;
}

/** 条目列表项（列表接口现在直接带 summary，避免逐条取详情） */
export interface EntryItem {
  id: string;
  title: string;
  categoryId: string;
  summary?: string;
  updatedAt: number;
}

/** 条目详情（写回时必须带 blocks 与 version） */
export interface EntryDetail {
  id: string;
  title: string;
  version: number;
  blocks: Array<{ title: string; contentJson: string; wordCount: number }>;
}

/** 分类 → Weave 预设色 */
const CATEGORY_COLOR: Record<string, string> = {
  人物: "blue",
  地点: "green",
  势力: "orange",
  物品: "yellow",
  事件: "cyan",
};

/** 节点尺寸（Weave 存档单位是「格」，1 格 = 20 像素） */
const NODE_SIZE = { w: 9, h: 4 };

/** 节点摘要长度上限（与后端列表接口的 substr 长度一致） */
const SUMMARY_LIMIT = 96;

/**
 * 取分类对应的 Weave 预设色。
 * @param categoryName 分类名
 * @returns 预设色名（未知分类回落为 blue）
 */
export function colorOfCategory(categoryName: string): string {
  return CATEGORY_COLOR[categoryName] ?? "blue";
}

/**
 * 把某个分类下的条目与关联转成 Weave 存档。
 * @param entries 该分类的条目
 * @param edges 该分类条目之间的关联（两端的条目 id）
 * @param layout 本地布局缓存（条目 id → 坐标）
 * @param categoryName 分类名（分区标签）
 * @param categoryId 分类 id（分区 id 用）
 * @returns Weave 存档
 */
export function buildCanvasPayload(
  entries: EntryItem[],
  edges: Array<{ from: string; to: string }>,
  layout: Record<string, { x: number; y: number; w?: number; h?: number }>,
  categoryName: string,
  categoryId: string,
): WeavePayload {
  const perRow = 3;
  const spacing = { x: 12, y: 5 };
  const nodes: WeaveNode[] = entries.map((entry, index) => {
    const row = Math.floor(index / perRow);
    const column = index % perRow;
    const cached = layout[entry.id];
    return {
      id: entry.id,
      label: entry.title,
      desc: (entry.summary ?? "").slice(0, SUMMARY_LIMIT),
      color: colorOfCategory(categoryName),
      // 有本地缓存的沿用缓存坐标，否则按网格落位（新建条目排到末尾）
      x: cached ? cached.x : column * (NODE_SIZE.w + spacing.x),
      y: cached ? cached.y : row * (NODE_SIZE.h + spacing.y),
      w: cached?.w ?? NODE_SIZE.w,
      h: cached?.h ?? NODE_SIZE.h,
      mirrored: false,
    };
  });

  const rowCount = Math.max(Math.ceil(entries.length / perRow), 1);
  const blockHeight = rowCount * (NODE_SIZE.h + spacing.y) - spacing.y;
  const regions: WeaveRegion[] = [
    {
      id: `region_${categoryId}`,
      label: categoryName,
      color: colorOfCategory(categoryName),
      x: -2,
      y: -2,
      w: perRow * (NODE_SIZE.w + spacing.x) - spacing.x + 4,
      h: blockHeight + 4,
      nodeIds: entries.map((entry) => entry.id),
      parentId: null,
    },
  ];

  const connections = edges.map((edge, index) => ({
    id: `c_${index + 1}`,
    from: edge.from,
    to: edge.to,
    label: "",
    mirrored: false,
  }));

  return { nodes, connections, regions, viewport: { panX: 140, panY: 90, scale: 0.85 } };
}

/** 深度遍历文档，收集 entryLink 标记指向的条目（正文里的关联） */
export function collectLinkTargets(contentJson: string, targets: Set<string>): void {
  try {
    const doc = JSON.parse(contentJson) as unknown;
    const visit = (node: unknown) => {
      if (!node || typeof node !== "object") {
        return;
      }
      const item = node as {
        marks?: Array<{ type?: string; attrs?: { entryId?: string } }>;
        content?: unknown[];
      };
      if (Array.isArray(item.marks)) {
        for (const mark of item.marks) {
          if (mark.type === "entryLink" && mark.attrs?.entryId) {
            targets.add(mark.attrs.entryId);
          }
        }
      }
      for (const child of item.content ?? []) {
        visit(child);
      }
    };
    visit(doc);
  } catch {
    // 跳过损坏块
  }
}

/**
 * 从画布存档里推导每个节点的出边（连线是有向的，与 entry_links 一致）。
 * @param payload 画布存档
 * @returns 节点 id → 目标节点 id 集合
 */
export function outgoingByNode(payload: WeavePayload): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const connection of payload.connections) {
    if (!result.has(connection.from)) {
      result.set(connection.from, new Set());
    }
    result.get(connection.from)?.add(connection.to);
  }
  return result;
}
