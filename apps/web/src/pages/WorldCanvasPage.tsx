import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";

/**
 * 世界画布页：以 iframe 嵌入 Weave（apps/web/public/weave/weave.html）作为条目编辑器。
 *
 * 为什么用 iframe：Weave 的工程约束要求它始终是单 HTML 文件、不得拆分为模块，因此无法
 * 作为 React 组件引入；这里用 iframe + postMessage 与它通信，Weave 本体保持原样，
 * 只在文件末尾追加了一行 `bridge.js`（见 public/weave/bridge.js）。
 *
 * 数据流：
 *   加载：数据库（条目 + 关联 + 分类）→ Weave 存档 → 注入画布
 *   编辑：画布变更 → 整份存档回传 → 与上次已同步状态做差异 → 写回数据库
 *
 * 差异合并只处理「结构」，不处理节点坐标：
 *   新增节点 → 新建条目；标题变化 → 更新条目标题；节点消失 → 删除条目
 *   连线增减 → 更新条目的关联（关键：写回关联时必须传全量 links，否则会被清空）
 *   节点坐标 → 写入浏览器本地（按世界 id 缓存布局，避免每次打开都重排）
 */

/** Weave 存档中的节点 */
interface WeaveNode {
  id: string;
  label: string;
  desc?: string;
  color?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  [key: string]: unknown;
}

/** Weave 存档中的连线 */
interface WeaveConnection {
  id: string;
  from: string;
  to: string;
  label?: string;
  [key: string]: unknown;
}

/** Weave 存档中的分区 */
interface WeaveRegion {
  id: string;
  label: string;
  color?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  nodeIds?: string[];
  parentId?: string | null;
}

/** Weave 存档结构 */
interface WeavePayload {
  nodes: WeaveNode[];
  connections: WeaveConnection[];
  regions?: WeaveRegion[];
  viewport?: { panX: number; panY: number; scale: number };
}

/** 世界信息（分类与名称） */
interface WorldInfo {
  id: string;
  name: string;
  categories: Array<{ id: string; name: string; color: string | null }>;
  canEdit?: boolean;
}

/** 条目列表项 */
interface EntryItem {
  id: string;
  title: string;
  categoryId: string;
  updatedAt: number;
}

/** 条目详情（保存正文时必须带上 blocks） */
interface EntryDetail {
  id: string;
  title: string;
  version: number;
  blocks: Array<{ title: string; contentJson: string; wordCount: number }>;
}

/** 画布页顶栏的同步状态 */
type SyncState = "loading" | "idle" | "syncing" | "error";

/** 分类 → Weave 预设色（与导出脚本保持一致） */
const CATEGORY_COLOR: Record<string, string> = {
  人物: "blue",
  地点: "green",
  势力: "orange",
  物品: "yellow",
  事件: "cyan",
};

/** 节点尺寸（Weave 存档单位是「格」，1 格 = 20 像素） */
const NODE_SIZE = { w: 9, h: 4 };

/** 画布数据变化后的合并延迟（毫秒）：等用户把一次操作做完 */
const SYNC_DEBOUNCE_MS = 1500;

/**
 * 本地布局缓存键：节点坐标只存在浏览器里，避免每次打开画布都重新排列。
 * @param worldId 世界 id
 * @returns localStorage 键名
 */
function layoutKey(worldId: string): string {
  return `create-world:canvas-layout:${worldId}`;
}

/** 读取本地布局缓存（无缓存或解析失败返回空对象） */
function readLayoutCache(worldId: string): Record<string, { x: number; y: number; w?: number; h?: number }> {
  try {
    const raw = localStorage.getItem(layoutKey(worldId));
    return raw ? (JSON.parse(raw) as Record<string, { x: number; y: number; w?: number; h?: number }>) : {};
  } catch {
    return {};
  }
}

/** 写入本地布局缓存 */
function writeLayoutCache(worldId: string, payload: WeavePayload): void {
  try {
    const layout: Record<string, { x: number; y: number; w?: number; h?: number }> = {};
    for (const node of payload.nodes) {
      layout[node.id] = { x: node.x, y: node.y, w: node.w, h: node.h };
    }
    localStorage.setItem(layoutKey(worldId), JSON.stringify(layout));
  } catch {
    // 本地存储不可用时忽略（隐私模式等）
  }
}

/** 从 TipTap 正文里取纯文本摘要 */
function summaryFromBlocks(blocks: EntryDetail["blocks"], limit = 96): string {
  for (const block of blocks ?? []) {
    try {
      const doc = JSON.parse(block.contentJson) as { content?: unknown[] };
      const chunks: string[] = [];
      const visit = (node: unknown) => {
        if (!node || typeof node !== "object") {
          return;
        }
        const item = node as { text?: string; content?: unknown[] };
        if (typeof item.text === "string") {
          chunks.push(item.text);
        }
        for (const child of item.content ?? []) {
          visit(child);
        }
      };
      visit(doc);
      const joined = chunks.join("").trim();
      if (joined) {
        return joined.length > limit ? `${joined.slice(0, limit)}…` : joined;
      }
    } catch {
      // 跳过损坏块
    }
  }
  return "";
}

/** 深度遍历文档，收集 entryLink 标记（用于重建关联） */
function collectLinkTargets(contentJson: string, targets: Set<string>): void {
  try {
    const doc = JSON.parse(contentJson) as unknown;
    const visit = (node: unknown) => {
      if (!node || typeof node !== "object") {
        return;
      }
      const item = node as { text?: string; marks?: Array<{ type?: string; attrs?: { entryId?: string } }>; content?: unknown[] };
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

/** 把条目与关联转成 Weave 存档：分类 → 分区画框，条目 → 节点，关联 → 连线 */
function entriesToWeave(
  world: WorldInfo,
  entries: EntryItem[],
  summaries: Map<string, string>,
  edges: Array<{ from: string; to: string }>,
  layout: Record<string, { x: number; y: number; w?: number; h?: number }>,
): WeavePayload {
  const categoryName = new Map(world.categories.map((category) => [category.id, category.name]));
  const grouped = new Map<string, EntryItem[]>();
  for (const entry of entries) {
    if (!grouped.has(entry.categoryId)) {
      grouped.set(entry.categoryId, []);
    }
    grouped.get(entry.categoryId)?.push(entry);
  }

  const nodes: WeaveNode[] = [];
  const regions: WeaveRegion[] = [];
  const spacing = { x: 12, y: 5 };
  let cursorY = 0;

  for (const category of world.categories) {
    const list = grouped.get(category.id) ?? [];
    if (list.length === 0) {
      continue;
    }
    const perRow = 3;
    const rowCount = Math.ceil(list.length / perRow);
    const blockHeight = rowCount * (NODE_SIZE.h + spacing.y) - spacing.y;

    list.forEach((entry, index) => {
      const row = Math.floor(index / perRow);
      const column = index % perRow;
      const cached = layout[entry.id];
      nodes.push({
        id: entry.id,
        label: entry.title,
        desc: summaries.get(entry.id) ?? "",
        color: CATEGORY_COLOR[categoryName.get(category.id) ?? ""] ?? "blue",
        // 有本地缓存的沿用缓存坐标，否则按分类分区落位
        x: cached ? cached.x : column * (NODE_SIZE.w + spacing.x),
        y: cached ? cached.y : cursorY + row * (NODE_SIZE.h + spacing.y),
        w: cached?.w ?? NODE_SIZE.w,
        h: cached?.h ?? NODE_SIZE.h,
        mirrored: false,
      });
    });

    regions.push({
      id: `region_${category.id}`,
      label: categoryName.get(category.id) ?? "",
      color: CATEGORY_COLOR[categoryName.get(category.id) ?? ""] ?? "blue",
      x: -2,
      y: cursorY - 2,
      w: 40,
      h: blockHeight + 4,
      nodeIds: list.map((entry) => entry.id),
      parentId: null,
    });

    cursorY += blockHeight + 7;
  }

  const connections: WeaveConnection[] = edges.map((edge, index) => ({
    id: `c_${index + 1}`,
    from: edge.from,
    to: edge.to,
    label: "",
    mirrored: false,
  }));

  return {
    nodes,
    connections,
    regions,
    viewport: { panX: 120, panY: 80, scale: 0.8 },
  };
}

/**
 * 世界画布页：Weave 画布 + 与数据库的双向同步。
 */
export default function WorldCanvasPage() {
  const { worldId = "" } = useParams<{ worldId: string }>();
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const worldRef = useRef<WorldInfo | null>(null);
  const bridgeReadyRef = useRef(false);
  const syncingRef = useRef(false);
  const pendingRef = useRef<WeavePayload | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  /** 上次成功同步到数据库的画布状态（差异合并的基线） */
  const syncedRef = useRef<Map<string, string>>(new Map());

  const [syncState, setSyncState] = useState<SyncState>("loading");
  const [syncMessage, setSyncMessage] = useState("正在加载条目…");
  const [error, setError] = useState("");

  /** 把画布数据发给 Weave（iframe 未就绪时记录为待发数据） */
  const pushDataToCanvas = useCallback((payload: WeavePayload, expectReady = false) => {
    const frame = iframeRef.current;
    if (!frame || !bridgeReadyRef.current) {
      if (expectReady) {
        pendingRef.current = payload;
      }
      return;
    }
    frame.contentWindow?.postMessage({ type: "weave:data", payload }, window.location.origin);
  }, []);

  /** 记录基线：id → 标题 */
  const rememberBaseline = useCallback((payload: WeavePayload) => {
    const baseline = new Map<string, string>();
    for (const node of payload.nodes) {
      baseline.set(node.id, node.label);
    }
    syncedRef.current = baseline;
  }, []);

  /**
   * 差异合并：把画布上的结构变化写回数据库。
   * 只做结构（新增/改名/删除节点、连线增减），坐标只进本地缓存。
   */
  const mergeChanges = useCallback(
    async (payload: WeavePayload) => {
      const world = worldRef.current;
      if (!world) {
        return;
      }
      if (syncingRef.current) {
        pendingRef.current = payload;
        return;
      }
      syncingRef.current = true;
      setSyncState("syncing");
      setSyncMessage("正在保存到世界…");

      try {
        // 1) 先从正文里补回关联（正文里已有的 entryLink 不该被画布上的删边覆盖）
        const details = await Promise.all(
          payload.nodes.map((node) => api<EntryDetail>(`/api/entries/${node.id}`).catch(() => null)),
        );
        const detailById = new Map<string, EntryDetail>();
        details.forEach((detail) => {
          if (detail) {
            detailById.set(detail.id, detail);
          }
        });

        const baseline = syncedRef.current;
        const currentIds = new Set(payload.nodes.map((node) => node.id));
        const removedIds = [...baseline.keys()].filter((id) => !currentIds.has(id));

        // 2) 删除：画布上已经消失的节点 → 删除条目（连同其关联）
        for (const id of removedIds) {
          await api(`/api/entries/${id}`, { method: "DELETE" }).catch(() => undefined);
        }

        // 3) 新增：画布上出现且数据库里没有的节点 → 建条目（带临时 id）
        const idMap = new Map<string, string>();
        const createdNew: string[] = [];
        for (const node of payload.nodes) {
          if (detailById.has(node.id)) {
            continue;
          }
          const categoryId = world.categories[0]?.id ?? "";
          try {
            const created = await api<{ id: string }>(`/api/worlds/${world.id}/entries`, {
              method: "POST",
              body: { title: node.label || "未命名条目", categoryId },
            });
            idMap.set(node.id, created.id);
            createdNew.push(node.id);
          } catch (err) {
            setSyncState("error");
            setSyncMessage(`新建条目失败：${(err as Error).message}`);
          }
        }

        // 4) 改名 / 关联：标题变化或连线变化的条目，一次 PUT 同时写回
        const edgeTargets = new Map<string, Set<string>>();
        for (const connection of payload.connections) {
          const from = idMap.get(connection.from) ?? connection.from;
          const to = idMap.get(connection.to) ?? connection.to;
          if (!edgeTargets.has(from)) {
            edgeTargets.set(from, new Set());
          }
          edgeTargets.get(from)?.add(to);
        }

        for (const node of payload.nodes) {
          const realId = idMap.get(node.id) ?? node.id;
          const detail = detailById.get(node.id);
          const isExisting = Boolean(detail);
          const titleChanged = isExisting && detail?.title !== node.label;
          const edges = edgeTargets.get(node.id) ?? new Set<string>();

          // 正文里已有的关联也要保留：并集写回
          const bodyTargets = new Set<string>();
          if (detail) {
            for (const block of detail.blocks) {
              collectLinkTargets(block.contentJson, bodyTargets);
            }
          }

          if (!titleChanged && detail && !createdNew.includes(node.id)) {
            // 判断关联是否真的变了：与当前数据库里的出边比较
            const { links } = await api<{ links?: Array<{ toEntryId: string }> }>(`/api/entries/${realId}`).catch(() => ({
              links: undefined,
            }));
            const current = new Set((links ?? []).map((link) => link.toEntryId));
            const same =
              current.size === edges.size && [...edges].every((target) => current.has(target) || target === realId);
            if (same) {
              continue;
            }
          }

          const titleById = new Map(payload.nodes.map((item) => [item.id, item.label]));
          const merged = new Set<string>([...edges, ...bodyTargets]);
          merged.delete(realId);

          const blocks =
            detail && !createdNew.includes(node.id)
              ? detail.blocks.map((block) => ({
                  title: block.title,
                  contentJson: block.contentJson,
                  wordCount: block.wordCount,
                }))
              : [{ title: "", contentJson: JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }), wordCount: 0 }];

          const links = [...merged].map((targetId) => ({
            toEntryId: targetId,
            toTitle: titleById.get(targetId) ?? "",
          }));

          await api(`/api/entries/${realId}/blocks`, {
            method: "PUT",
            body: {
              baseVersion: detail && !createdNew.includes(node.id) ? detail.version : 1,
              title: node.label || "未命名条目",
              blocks,
              // 关键：必须传全量 links，服务端按「空关联」处理会清掉既有边
              links,
              createVersion: false,
              note: "",
            },
          }).catch(async (err: Error) => {
            setSyncState("error");
            setSyncMessage(`更新条目失败：${err.message}`);
          });
        }

        // 5) 本地缓存布局，供下次打开恢复
        writeLayoutCache(world.id, payload);
        rememberBaseline(payload);
        setSyncState("idle");
        setSyncMessage("已保存");
      } catch (err) {
        setSyncState("error");
        setSyncMessage(`同步失败：${(err as Error).message}`);
      } finally {
        syncingRef.current = false;
        const queued = pendingRef.current;
        pendingRef.current = null;
        if (queued) {
          void mergeChanges(queued);
        }
      }
    },
    [rememberBaseline],
  );

  /** 防抖安排一次同步 */
  const scheduleSync = useCallback(
    (payload: WeavePayload) => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
      }
      syncTimerRef.current = window.setTimeout(() => {
        syncTimerRef.current = null;
        void mergeChanges(payload);
      }, SYNC_DEBOUNCE_MS);
    },
    [mergeChanges],
  );

  /** 首次加载：世界信息 + 条目 + 关联 → 注入画布 */
  const loadWorld = useCallback(async () => {
    setSyncState("loading");
    setSyncMessage("正在加载条目…");
    try {
      const [world, entries, graph] = await Promise.all([
        api<WorldInfo>(`/api/worlds/${worldId}`),
        api<EntryItem[]>(`/api/worlds/${worldId}/entries`),
        api<{ nodes: Array<{ id: string }>; links: Array<{ source: string; target: string }> }>(
          `/api/worlds/${worldId}/graph`,
        ),
      ]);
      worldRef.current = world;

      // 摘要在节点里显示，需要逐条取详情（世界条目规模有限，并发即可）
      const details = await Promise.all(
        entries.map((entry) => api<EntryDetail>(`/api/entries/${entry.id}`).catch(() => null)),
      );
      const summaries = new Map<string, string>();
      details.forEach((detail) => {
        if (detail) {
          summaries.set(detail.id, summaryFromBlocks(detail.blocks));
        }
      });

      const edges = graph.links.map((link) => ({ from: String(link.source), to: String(link.target) }));
      const payload = entriesToWeave(world, entries, summaries, edges, readLayoutCache(worldId));
      rememberBaseline(payload);
      pushDataToCanvas(payload, true);
      setSyncState("idle");
      setSyncMessage(`已载入 ${entries.length} 条`);
    } catch (err) {
      setError((err as Error).message);
      setSyncState("error");
      setSyncMessage((err as Error).message);
    }
  }, [pushDataToCanvas, rememberBaseline, worldId]);

  // 首屏加载
  useEffect(() => {
    void loadWorld();
  }, [loadWorld]);

  // 与画布通信：接收就绪、变更、状态与「打开条目」请求
  useEffect(() => {
    /** 处理来自画布 iframe 的消息 */
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const data = event.data as { type?: string; payload?: WeavePayload; nodeId?: string; message?: string };
      if (data.type === "weave:ready") {
        bridgeReadyRef.current = true;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending) {
          pushDataToCanvas(pending);
        } else {
          void loadWorld();
        }
        return;
      }
      if (data.type === "weave:change" && data.payload) {
        setSyncState("syncing");
        setSyncMessage("画布已修改，准备保存…");
        scheduleSync(data.payload);
        return;
      }
      if (data.type === "weave:open-entry" && data.nodeId) {
        navigate(`/w/${worldId}/entries/${data.nodeId}`);
        return;
      }
      if (data.type === "weave:status" && data.message) {
        setSyncMessage(data.message);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [loadWorld, navigate, pushDataToCanvas, scheduleSync, worldId]);

  const stateLabel = useMemo(() => {
    switch (syncState) {
      case "loading":
        return "加载中";
      case "syncing":
        return "保存中";
      case "error":
        return "同步异常";
      default:
        return "已同步";
    }
  }, [syncState]);

  if (error) {
    return <div className="notice error">{error}</div>;
  }

  return (
    <div className="canvas-page">
      <div className="canvas-toolbar">
        <div className="canvas-toolbar-left">
          <span className="canvas-title">画布</span>
          <span className={`canvas-sync canvas-sync-${syncState}`}>{stateLabel}</span>
          <span className="canvas-sync-detail">{syncMessage}</span>
        </div>
        <div className="canvas-toolbar-right">
          <button type="button" className="btn ghost small" onClick={() => void loadWorld()}>
            重新载入
          </button>
          <Link to={`/w/${worldId}/timeline`} className="btn ghost small">
            时间线
          </Link>
        </div>
      </div>
      <iframe
        ref={iframeRef}
        className="canvas-frame"
        src="/weave/weave.html"
        title="画布编辑器"
        allow="clipboard-write"
      />
    </div>
  );
}
