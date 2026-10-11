import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import {
  buildCanvasPayload,
  collectLinkTargets,
  outgoingByNode,
  type EntryDetail,
  type EntryItem,
  type WorldInfo,
} from "../lib/weave-data";
import { readLayout, readSnapshot, writeLayout, writeSnapshot } from "../lib/weave-cache";
import {
  canvasInternals,
  dispatchCanvas,
  registerCanvasActionHandler,
  subscribeCanvas,
  useCanvasState,
  type WeavePayload,
} from "../lib/weave-store";

/**
 * 画布宿主：常驻在世界区布局里，负责 iframe、与同步桥通信、加载与写回数据库。
 *
 * 为什么常驻：早先画布页是普通路由，离开画布就卸载 iframe，回来时要重新下载并启动 Weave，
 * 于是「切走再切回来」要等很久。改成常驻后只隐藏不销毁，切回来只是再注入一次数据。
 */

/** 画布数据变化后的合并延迟（毫秒）：等用户把一次操作做完 */
const SYNC_DEBOUNCE_MS = 1500;

/** 与 Weave 通信的消息体 */
interface BridgeMessage {
  type?: string;
  payload?: WeavePayload;
  nodeId?: string;
  message?: string;
}

/**
 * 画布宿主组件。
 * @param props.worldId 当前世界 id（来自路由）
 * @param props.active 是否正在展示画布（false 时只隐藏、不卸载）
 */
export default function CanvasHost({ worldId, active }: { worldId: string; active: boolean }) {
  const navigate = useNavigate();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  /** 是否已经进过画布：没进过就完全不挂载 iframe，避免其它页面白下载 460KB 画布文件 */
  const [mounted, setMounted] = useState(false);
  const bridgeReadyRef = useRef(false);
  const syncingRef = useRef(false);
  const pendingPayloadRef = useRef<WeavePayload | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  /** 已成功写回数据库的标题基线：条目 id → 标题 */
  const baselineTitlesRef = useRef<Map<string, string>>(new Map());
  /** 当前画布的条目集合与出边（写回时用来判断哪些条目真的要改） */
  const detailCacheRef = useRef<Map<string, EntryDetail>>(new Map());
  /** 上次写回时的出边基线：条目 id → 目标条目 id 集合（用于判断连线是否真的变了） */
  const edgeSetsRef = useRef<Map<string, Set<string>>>(new Map());
  /** 正在加载的世界与分类（防止重复请求） */
  const loadingKeyRef = useRef("");
  /** 组件卸载标记：避免异步回写 setState */
  const aliveRef = useRef(true);

  const state = useCanvasState();

  /** 记录基线（标题 + 出边），同步与删除判定都基于它 */
  const rememberBaseline = useCallback((payload: WeavePayload) => {
    baselineTitlesRef.current = new Map(payload.nodes.map((node) => [node.id, node.label]));
  }, []);

  /** 把画布数据发给 iframe（桥未就绪时先存起来，收到 ready 再发） */
  const pushToCanvas = useCallback((payload: WeavePayload) => {
    const frame = frameRef.current;
    if (!frame || !bridgeReadyRef.current) {
      pendingPayloadRef.current = payload;
      return;
    }
    frame.contentWindow?.postMessage({ type: "weave:data", payload }, window.location.origin);
  }, []);

  /**
   * 差异合并：把画布上的结构变化写回数据库。
   * 只处理结构（新增/改名/删除节点、连线增减），节点坐标只进本地缓存。
   * @param payload 画布存档
   * @param world 世界信息
   * @param categoryId 当前分类（新建条目归入该分类）
   */
  const mergeChanges = useCallback(
    async (payload: WeavePayload, world: WorldInfo, categoryId: string) => {
      if (syncingRef.current) {
        pendingPayloadRef.current = payload;
        return;
      }
      syncingRef.current = true;
      canvasInternals.setState({ phase: "syncing", message: "正在保存到世界…" });

      try {
        const baselineTitles = baselineTitlesRef.current;
        const currentIds = new Set(payload.nodes.map((node) => node.id));
        const removedIds = [...baselineTitles.keys()].filter((id) => !currentIds.has(id));

        // 1) 画布上被删掉的节点 → 删除对应条目
        for (const id of removedIds) {
          await api(`/api/entries/${id}`, { method: "DELETE" }).catch(() => undefined);
          detailCacheRef.current.delete(id);
        }

        // 2) 画布上新增的节点 → 新建条目（id 用临时 id，建好后做映射）
        const idMap = new Map<string, string>();
        for (const node of payload.nodes) {
          if (detailCacheRef.current.has(node.id)) {
            continue;
          }
          try {
            const created = await api<{ id: string }>(`/api/worlds/${world.id}/entries`, {
              method: "POST",
              body: { title: node.label || "未命名条目", categoryId },
            });
            idMap.set(node.id, created.id);
          } catch (err) {
            canvasInternals.setState({ phase: "error", message: `新建条目失败：${(err as Error).message}` });
          }
        }

        // 3) 改名与连线：标题变化或出边变化的条目，各一次 PUT 写回
        const outgoing = outgoingByNode(payload);
        const titleOf = new Map(payload.nodes.map((node) => [node.id, node.label]));

        for (const node of payload.nodes) {
          const realId = idMap.get(node.id) ?? node.id;
          // 列表接口不含正文 blocks：需要写回的条目在这里补一次详情
          let detail = detailCacheRef.current.get(node.id);
          if (!detail) {
            const fetched = await api<EntryDetail>(`/api/entries/${realId}`).catch(() => null);
            if (fetched) {
              detail = fetched;
              detailCacheRef.current.set(node.id, fetched);
            }
          }
          const isNew = detail === undefined;
          const titleChanged = detail !== undefined && detail.title !== node.label;
          const edges = outgoing.get(node.id) ?? new Set<string>();

          // 正文里已有的关联要保留：与画布连线取并集，再排除自身
          const bodyTargets = new Set<string>();
          if (detail) {
            for (const block of detail.blocks) {
              collectLinkTargets(block.contentJson, bodyTargets);
            }
          }
          const merged = new Set<string>([...edges, ...bodyTargets]);
          merged.delete(realId);

          // 判断该条目是否真的需要写回：新建 / 标题变化 / 出边变化
          const baselineEdges = edgeSetsRef.current.get(node.id);
          const sameEdges =
            baselineEdges !== undefined &&
            baselineEdges.size === edges.size &&
            [...edges].every((target) => baselineEdges.has(target));
          const bodyHasExtra = [...bodyTargets].some((target) => target !== realId && !edges.has(target));

          if (!isNew && !titleChanged && sameEdges && !bodyHasExtra) {
            continue;
          }

          const blocks = detail
            ? detail.blocks.map((block) => ({
                title: block.title,
                contentJson: block.contentJson,
                wordCount: block.wordCount,
              }))
            : [
                {
                  title: "",
                  contentJson: JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
                  wordCount: 0,
                },
              ];

          const links = [...merged].map((targetId) => ({
            toEntryId: targetId,
            toTitle: titleOf.get(targetId) ?? "",
          }));

          try {
            await api(`/api/entries/${realId}/blocks`, {
              method: "PUT",
              body: {
                baseVersion: detail ? detail.version : 1,
                title: node.label || "未命名条目",
                blocks,
                // 关键：必须传全量 links，服务端把「未传」当空关联会清掉既有边
                links,
                createVersion: false,
                note: "",
              },
            });
            // 写回成功后才更新缓存：否则下次会用过期 version 触发 409
            detailCacheRef.current.set(node.id, {
              id: realId,
              title: node.label,
              version: (detail?.version ?? 1) + 1,
              blocks,
            });
          } catch (err) {
            canvasInternals.setState({ phase: "error", message: `更新条目失败：${(err as Error).message}` });
          }
        }

        // 4) 缓存坐标与快照，便于下次秒开
        writeLayout(world.id, categoryId, payload);
        writeSnapshot(world.id, categoryId, payload);
        rememberBaseline(payload);
        edgeSetsRef.current = outgoingByNode(payload);
        canvasInternals.setState({ phase: "ready", message: "已保存" });
      } catch (err) {
        canvasInternals.setState({ phase: "error", message: `同步失败：${(err as Error).message}` });
      } finally {
        syncingRef.current = false;
        const queued = pendingPayloadRef.current;
        pendingPayloadRef.current = null;
        if (queued) {
          void mergeChanges(queued, world, categoryId);
        }
      }
    },
    [rememberBaseline],
  );

  /** 防抖安排一次同步 */
  const scheduleSync = useCallback(
    (payload: WeavePayload, world: WorldInfo, categoryId: string) => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
      }
      syncTimerRef.current = window.setTimeout(() => {
        syncTimerRef.current = null;
        void mergeChanges(payload, world, categoryId);
      }, SYNC_DEBOUNCE_MS);
    },
    [mergeChanges],
  );

  /**
   * 加载某个分类的画布：先用缓存即刻上屏，再拉最新数据替换。
   * @param targetWorldId 世界 id
   * @param categoryId 分类 id
   * @param force 为 true 时忽略缓存，直接等接口（重新载入按钮用）
   */
  const loadCanvas = useCallback(
    async (targetWorldId: string, categoryId: string, force = false) => {
      if (!targetWorldId || !categoryId) {
        return;
      }
      const key = `${targetWorldId}:${categoryId}`;
      if (!force && loadingKeyRef.current === key) {
        return;
      }
      loadingKeyRef.current = key;

      // 1) 先用本地快照立刻上屏（切分类、切页面回来时几乎无感）
      const cached = force ? null : readSnapshot(targetWorldId, categoryId);
      if (cached) {
        pushToCanvas(cached);
        rememberBaseline(cached);
        canvasInternals.setState({
          worldId: targetWorldId,
          categoryId,
          snapshot: cached,
          phase: "local",
          message: "已显示本地缓存，正在获取最新数据…",
        });
      } else {
        canvasInternals.setState({
          worldId: targetWorldId,
          categoryId,
          snapshot: null,
          phase: "loading",
          message: "正在加载…",
        });
      }

      // 2) 拉最新数据：列表接口已带摘要，无需再逐条取详情
      try {
        const [world, entries, graph] = await Promise.all([
          api<WorldInfo>(`/api/worlds/${targetWorldId}`),
          api<EntryItem[]>(`/api/worlds/${targetWorldId}/entries?categoryId=${encodeURIComponent(categoryId)}`),
          api<{ links: Array<{ source: string; target: string }> }>(`/api/worlds/${targetWorldId}/graph`),
        ]);
        if (!aliveRef.current) {
          return;
        }
        if (canvasInternals.getState().categoryId !== categoryId) {
          // 用户已经切到别的分类，这批数据作废
          return;
        }

        const categoryName = world.categories.find((item) => item.id === categoryId)?.name ?? "条目";
        const idSet = new Set(entries.map((entry) => entry.id));
        const edges = graph.links
          .map((link) => ({ from: String(link.source), to: String(link.target) }))
          .filter((edge) => idSet.has(edge.from) && idSet.has(edge.to));

        const layout = readLayout(targetWorldId, categoryId);
        const payload = buildCanvasPayload(entries, edges, layout, categoryName, categoryId);

        // 详情缓存用于写回时判断「是否真的变化」（列表接口不含 blocks）
        detailCacheRef.current = new Map();
        edgeSetsRef.current = outgoingByNode(payload);

        pushToCanvas(payload);
        rememberBaseline(payload);
        writeSnapshot(targetWorldId, categoryId, payload);
        canvasInternals.setState({
          worldId: targetWorldId,
          categoryId,
          snapshot: payload,
          phase: "ready",
          message: `已载入 ${entries.length} 条`,
        });
      } catch (err) {
        if (aliveRef.current) {
          canvasInternals.setState({ phase: "error", message: `加载失败：${(err as Error).message}` });
        }
      }
    },
    [pushToCanvas, rememberBaseline],
  );

  // 订阅状态：分类变化时加载对应画布
  useEffect(() => {
    /** 处理 store 状态变化：世界或分类变了就重新加载 */
    const handle = () => {
      const next = canvasInternals.getState();
      if (!next.worldId || !next.categoryId) {
        return;
      }
      const key = `${next.worldId}:${next.categoryId}`;
      if (loadingKeyRef.current !== key) {
        void loadCanvas(next.worldId, next.categoryId);
      }
    };
    return subscribeCanvas(handle);
  }, [loadCanvas]);

  // 页面下发的动作（激活 / 重新载入 / 停用）
  useEffect(() => {
    return registerCanvasActionHandler((action) => {
      if (action.type === "activate") {
        void loadCanvas(action.worldId, action.categoryId);
        return;
      }
      if (action.type === "reload") {
        const current = canvasInternals.getState();
        if (current.worldId && current.categoryId) {
          void loadCanvas(current.worldId, current.categoryId, true);
        }
        return;
      }
      if (action.type === "deactivate") {
        // 保留 iframe 与缓存，仅停止后续请求
        loadingKeyRef.current = "";
      }
    });
  }, [loadCanvas]);

  // 与同步桥通信
  useEffect(() => {
    /** 处理来自画布 iframe 的消息 */
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const data = (event.data ?? {}) as BridgeMessage;
      if (data.type === "weave:ready") {
        bridgeReadyRef.current = true;
        const pending = pendingPayloadRef.current;
        pendingPayloadRef.current = null;
        if (pending) {
          pushToCanvas(pending);
        } else {
          const current = canvasInternals.getState();
          if (current.worldId && current.categoryId) {
            void loadCanvas(current.worldId, current.categoryId);
          }
        }
        return;
      }
      if (data.type === "weave:change" && data.payload) {
        const current = canvasInternals.getState();
        canvasInternals.setState({ phase: "syncing", message: "画布已修改，准备保存…" });
        void (async () => {
          const world = await api<WorldInfo>(`/api/worlds/${current.worldId}`).catch(() => null);
          if (!world) {
            return;
          }
          scheduleSync(data.payload as WeavePayload, world, current.categoryId);
        })();
        return;
      }
      if (data.type === "weave:open-entry" && data.nodeId) {
        const current = canvasInternals.getState();
        navigate(`/w/${current.worldId}/entries/${data.nodeId}`);
        return;
      }
      if (data.type === "weave:status" && data.message) {
        canvasInternals.setState({ message: data.message });
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [loadCanvas, navigate, pushToCanvas, scheduleSync]);

  // 卸载时停止后续回写
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
      }
    };
  }, []);

  // 首次进入画布才挂载 iframe；之后常驻不销毁（切页面回来无需重新加载）
  useEffect(() => {
    if (active) {
      setMounted(true);
    }
  }, [active]);

  // iframe 加载完成后（桥会自行发 ready），确保当前分类的数据已下发
  useEffect(() => {
    if (!frameReady || !active) {
      return;
    }
    const current = canvasInternals.getState();
    if (current.worldId && current.categoryId) {
      void loadCanvas(current.worldId, current.categoryId);
    }
  }, [active, frameReady, loadCanvas]);

  if (!mounted) {
    return null;
  }

  return (
    <div className={`canvas-host${active ? " is-active" : ""}`} aria-hidden={!active}>
      <iframe
        ref={frameRef}
        className="canvas-frame"
        // 带构建版本戳，避免 CDN/浏览器缓存命中旧的画布文件（版本不变时可长期缓存）
        src={`/weave/weave.html?v=${__CANVAS_VERSION__}`}
        title="画布编辑器"
        allow="clipboard-write"
        onLoad={() => setFrameReady(true)}
      />
      {state.phase === "loading" && <div className="canvas-veil">正在加载画布…</div>}
    </div>
  );
}

declare const __CANVAS_VERSION__: string;

export { dispatchCanvas };
