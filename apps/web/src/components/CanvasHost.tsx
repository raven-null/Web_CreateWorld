import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError, api } from "../lib/api";
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
  readOnly?: boolean;
}

/**
 * 让画布进入只读模式。
 *
 * 背景：未登录（或没有编辑权限）时，条目是「可读不可写」——服务端会 401/403。
 * 早先的实现照样允许拖拽与新建，于是每次改动都发一堆注定失败的请求（实测刷出上百条 401）。
 * 进入只读后 Weave 自身会拦住编辑动作，从源头避免无效请求。
 *
 * @param readOnly 是否只读
 */
function setCanvasReadOnly(readOnly: boolean): void {
  const frame = document.querySelector<HTMLIFrameElement>(".canvas-frame");
  frame?.contentWindow?.postMessage({ type: "weave:readonly", readOnly }, window.location.origin);
}

/** 条目写回的最大尝试次数（首次 + 版本冲突重试一次） */
const SAVE_MAX_ATTEMPTS = 2;

/**
 * 把画布上的节点 id 换成数据库里的真实条目 id。
 *
 * 使用场景：画布上新建的节点自带 Weave 生成的临时 id，父页面为它创建条目后拿到真实 id，
 * 必须把画布上那个临时 id 换掉——否则下一轮同步又会把同一个节点当成「新增」，
 * 于是重复创建条目（实测曾因此把世界刷出 276 条重复条目）。
 *
 * @param payload 当前画布存档
 * @param idMap 临时节点 id → 真实条目 id
 * @returns 替换后的新存档（连接与分区里的引用一并跟着换）
 */
function rewriteNodeIds(payload: WeavePayload, idMap: Map<string, string>): WeavePayload {
  const map = (id: string): string => idMap.get(id) ?? id;
  return {
    ...payload,
    nodes: payload.nodes.map((node) => ({ ...node, id: map(node.id) })),
    connections: payload.connections.map((connection) => ({
      ...connection,
      from: map(connection.from),
      to: map(connection.to),
    })),
    regions: (payload.regions ?? []).map((region) => ({
      ...region,
      nodeIds: (region.nodeIds ?? []).map(map),
    })),
  };
}

/**
 * 把条目正文与关联写回数据库，遇到版本冲突（409）时用服务端给的最新版本重试一次。
 *
 * 为什么必须重试：画布是多节点批量写回，同一条目可能被两次合并同时处理（或用户在另一处
 * 编辑过），此时服务端返回 409 + latestVersion。早先的实现把 409 当普通失败丢弃，
 * 于是日志里刷出一片 409，而画布上的改动其实没保存成功。
 *
 * @param entryId 条目 id
 * @param title 条目标题
 * @param blocks 内容块（不传表示只改标题与关联）
 * @param links 关联（必须传全量，服务端按空关联处理会清掉既有边）
 * @param seed 已知的最新详情（用于首轮 baseVersion）
 * @returns 写入成功时的版本号；失败返回 null
 */
async function saveEntryBlocks(
  entryId: string,
  title: string,
  blocks: Array<{ title: string; contentJson: string; wordCount: number }> | undefined,
  links: Array<{ toEntryId: string; toTitle: string }>,
  seed: { version: number; blocks: Array<{ title: string; contentJson: string; wordCount: number }> } | null,
): Promise<number | null> {
  let latest = seed;
  for (let attempt = 0; attempt < SAVE_MAX_ATTEMPTS; attempt += 1) {
    // 首轮用已知版本；冲突重试前重新拉一次最新版本
    if (!latest || attempt > 0) {
      const fresh = await api<EntryDetail>(`/api/entries/${entryId}`).catch(() => null);
      if (!fresh) {
        return null;
      }
      latest = { version: fresh.version, blocks: fresh.blocks };
    }
    try {
      await api(`/api/entries/${entryId}/blocks`, {
        method: "PUT",
        body: {
          baseVersion: latest.version,
          title,
          blocks: blocks ?? latest.blocks,
          links,
          createVersion: false,
          note: "",
        },
      });
      return latest.version + 1;
    } catch (error) {
      const conflict = error instanceof ApiError && error.status === 409;
      if (!conflict) {
        // 未登录 / 无权限：不再重试，交由上层统一处理（避免刷屏的 401）
        return null;
      }
      // 版本冲突：下一轮用重新拉取到的版本重试
      latest = null;
    }
  }
  return null;
}

/**
 * 画布宿主组件。
 * @param props.worldId 当前世界 id（来自路由）
 * @param props.active 是否正在展示画布（false 时只隐藏、不卸载）
 */
export default function CanvasHost({ worldId, active }: { worldId: string; active: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  /** 是否已经进过画布：没进过就完全不挂载 iframe，避免其它页面白下载 460KB 画布文件 */
  const [mounted, setMounted] = useState(false);
  /** 桥是否已就绪（收到 weave:ready）：就绪前用遮罩盖住 iframe，避免看到未注入数据的画布 */
  const [bridgeReady, setBridgeReady] = useState(false);
  const bridgeReadyRef = useRef(false);
  const syncingRef = useRef(false);
  const pendingPayloadRef = useRef<WeavePayload | null>(null);
  /** 与 pendingPayloadRef 配套的分类（桥就绪后补发时要还原上下文） */
  const pendingCategoryRef = useRef("");
  const syncTimerRef = useRef<number | null>(null);
  /** 已成功写回数据库的标题基线：条目 id → 标题 */
  const baselineTitlesRef = useRef<Map<string, string>>(new Map());
  /** 当前画布上已知的条目详情（version + blocks），写回时用最新版本避免 409 */
  const detailCacheRef = useRef<Map<string, EntryDetail>>(new Map());
  /** 上次写回时的出边基线：条目 id → 目标条目 id 集合（用于判断连线是否真的变了） */
  const edgeSetsRef = useRef<Map<string, Set<string>>>(new Map());
  /** 正在加载的世界与分类（防止重复请求） */
  const loadingKeyRef = useRef("");
  /** 当前画布内容对应的分类：写回缓存时用它，避免分类切换期间张冠李戴 */
  const payloadCategoryRef = useRef("");
  /** 同步串行化：同一时刻只跑一个合并，避免对同一条目并发写导致 409 */
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  /** 是否因未登录/无权限而锁定状态：锁定后不再发起任何写请求 */
  const statusLockedRef = useRef(false);
  /** 组件卸载标记：避免异步回写 setState */
  const aliveRef = useRef(true);

  const state = useCanvasState();

  /** 记录基线（标题 + 出边），同步与删除判定都基于它 */
  const rememberBaseline = useCallback((payload: WeavePayload) => {
    baselineTitlesRef.current = new Map(payload.nodes.map((node) => [node.id, node.label]));
  }, []);

  /** 把画布数据发给 iframe（桥未就绪时先存起来，收到 ready 再发） */
  const pushToCanvas = useCallback((payload: WeavePayload, categoryId: string) => {
    // 记录这批内容属于哪个分类：合并写回时用它写缓存，避免分类切换期间张冠李戴
    payloadCategoryRef.current = categoryId;
    const frame = frameRef.current;
    if (!frame || !bridgeReadyRef.current) {
      pendingPayloadRef.current = payload;
      pendingCategoryRef.current = categoryId;
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
        /** 本轮是否出现过写失败（最后统一汇报，避免被后续 setState 覆盖） */
        let failedMessage = "";

        // 1) 画布上被删掉的节点 → 删除对应条目
        for (const id of removedIds) {
          await api(`/api/entries/${id}`, { method: "DELETE" }).catch((err: unknown) => {
            if (err instanceof ApiError && err.status === 401) {
              statusLockedRef.current = true;
              failedMessage = "未登录，改动未保存";
            }
          });
          detailCacheRef.current.delete(id);
        }

        // 2) 画布上新增的节点 → 新建条目（id 用临时 id，建好后做映射）
        const idMap = new Map<string, string>();
        if (!statusLockedRef.current) {
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
              // 未登录 / 无权限：立刻停止后续写操作，避免刷屏的 401
              if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
                statusLockedRef.current = true;
                failedMessage = err.status === 401 ? "未登录，改动未保存" : "没有编辑权限，改动未保存";
                break;
              }
              failedMessage = `新建条目失败：${(err as Error).message}`;
            }
          }
        }

        // 3) 改名与连线：标题变化或出边变化的条目，各一次 PUT 写回
        const outgoing = outgoingByNode(payload);
        const titleOf = new Map(payload.nodes.map((node) => [node.id, node.label]));

        // 未登录 / 无权限时不做任何写操作，避免刷出一屏 401
        if (statusLockedRef.current) {
          canvasInternals.setState({
            phase: "error",
            message: failedMessage || "未登录或没有编辑权限，改动未保存",
          });
          return;
        }

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

          // 写回（内部处理 409：用服务端最新版本重试一次）
          const newVersion = await saveEntryBlocks(
            realId,
            node.label || "未命名条目",
            blocks,
            links,
            detail ? { version: detail.version, blocks: detail.blocks } : null,
          );
          if (newVersion === null) {
            // saveEntryBlocks 返回 null 时已在内部判断过 401/403；这里只兜底记录
            failedMessage = failedMessage || "保存条目失败（版本冲突重试后仍未成功）";
            if (statusLockedRef.current) {
              break;
            }
            continue;
          }
          // 写回成功后才更新缓存：否则下次会用过期 version 触发 409
          detailCacheRef.current.set(node.id, {
            id: realId,
            title: node.label,
            version: newVersion,
            blocks,
          });
        }

        // 4) 缓存坐标与快照，便于下次秒开
        // 用「当前画布内容所属的分类」而不是本次调用的参数：分类切换期间两者可能不同
        const payloadCategory = payloadCategoryRef.current || categoryId;
        writeLayout(world.id, payloadCategory, payload);
        writeSnapshot(world.id, payloadCategory, payload);
        rememberBaseline(payload);
        edgeSetsRef.current = outgoingByNode(payload);
        if (failedMessage) {
          canvasInternals.setState({ phase: "error", message: failedMessage });
        } else {
          canvasInternals.setState({ phase: "ready", message: "已保存" });
        }

        /**
         * 5) 本轮新建了条目 → 把画布上的**临时 id 换成真实条目 id**。
         *
         * 不换会出大问题：画布节点一直是临时 id，下一轮同步又会把它当成「画布上新增的节点」，
         * 于是重复 POST 建条目——实测已经因此把某个世界刷出 200 条重复条目。
         * 换 id 只能整体重注入（Weave 的节点 id 与 DOM 缓存绑定），重注入后这份数据与数据库一致，
         * 所以把它记为新的基线并缓存下来。
         */
        if (idMap.size > 0) {
          const renamed = rewriteNodeIds(payload, idMap);
          pushToCanvas(renamed, payloadCategory);
          writeLayout(world.id, payloadCategory, renamed);
          writeSnapshot(world.id, payloadCategory, renamed);
          rememberBaseline(renamed);
          edgeSetsRef.current = outgoingByNode(renamed);
          // 画布上的 id 变了：缓存里的 key 也要跟着换，否则下一轮又会误判成新节点
          const renamedDetails = new Map<string, EntryDetail>();
          for (const [tempId, realId] of idMap) {
            const detail = detailCacheRef.current.get(tempId);
            if (detail) {
              renamedDetails.set(realId, detail);
            }
          }
          for (const [key, detail] of detailCacheRef.current) {
            if (!idMap.has(key)) {
              renamedDetails.set(key, detail);
            }
          }
          detailCacheRef.current = renamedDetails;
        }
      } catch (err) {
        canvasInternals.setState({ phase: "error", message: `同步失败：${(err as Error).message}` });
      } finally {
        syncingRef.current = false;
        const queued = pendingPayloadRef.current;
        pendingPayloadRef.current = null;
        // 未登录/无权限时不再重试排队内容，避免无限刷请求
        if (queued && !statusLockedRef.current) {
          void mergeChanges(queued, world, categoryId);
        }
      }
    },
    [rememberBaseline],
  );

  /**
   * 防抖安排一次同步，并串行执行。
   * 串行的意义：同一批条目的两次合并若并发跑，会用同一个旧 version 各写一次，
   * 服务端对第二个返回 409（此前日志里成片 409 就是这个原因）。
   * @param payload 画布存档
   * @param world 世界信息
   * @param categoryId 画布所属分类
   */
  const scheduleSync = useCallback(
    (payload: WeavePayload, world: WorldInfo, categoryId: string) => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
      }
      syncTimerRef.current = window.setTimeout(() => {
        syncTimerRef.current = null;
        queueRef.current = queueRef.current.then(() => mergeChanges(payload, world, categoryId)).catch(() => undefined);
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
      console.info("[canvas] 开始加载", key, "force=", force);

      // 1) 先用本地快照立刻上屏（切分类、切页面回来时几乎无感）
      const cached = force ? null : readSnapshot(targetWorldId, categoryId);
      if (cached) {
        /**
         * 快照来源决定 id 能不能信：
         *   · memory（本次会话）→ 节点 id 就是数据库 id，直接采信；
         *   · storage（上次会话留下的）→ 里面的 id 可能是父页面还没替换的临时 id，
         *     不能当成「已存在的条目」，因此清掉详情缓存，让本轮同步按 id 去接口取一次再判定。
         */
        if (cached.source === "storage") {
          detailCacheRef.current = new Map();
        }
        const cachedPayload = cached.payload;
        pushToCanvas(cachedPayload, categoryId);
        rememberBaseline(cachedPayload);
        // 缓存上屏后要重置同步基线：缓存里的内容与画布当前内容一致，避免被当成「新改动」回写
        edgeSetsRef.current = outgoingByNode(cachedPayload);
        canvasInternals.setState({
          worldId: targetWorldId,
          categoryId,
          snapshot: cachedPayload,
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
        // 只在「当前分类仍是这个」时注入：否则用户在等待期间切走了，注入会把画布内容覆盖回去
        if (canvasInternals.getState().categoryId !== categoryId) {
          return;
        }

        const categoryName = world.categories.find((item) => item.id === categoryId)?.name ?? "条目";

        // 权限决定画布能否编辑：未登录（canEdit=false）时进入只读，避免注定失败的写请求
        const canEdit = Boolean((world as { canEdit?: boolean }).canEdit);
        statusLockedRef.current = !canEdit;
        setCanvasReadOnly(!canEdit);
        if (!canEdit) {
          canvasInternals.setState({ message: "只读：登录后才能编辑" });
        }
        const idSet = new Set(entries.map((entry) => entry.id));
        const edges = graph.links
          .map((link) => ({ from: String(link.source), to: String(link.target) }))
          .filter((edge) => idSet.has(edge.from) && idSet.has(edge.to));

        const layout = readLayout(targetWorldId, categoryId);
        const payload = buildCanvasPayload(entries, edges, layout, categoryName, categoryId);

        // 详情缓存用于写回时判断「是否真的变化」（列表接口不含 blocks）
        detailCacheRef.current = new Map();
        edgeSetsRef.current = outgoingByNode(payload);

        pushToCanvas(payload, categoryId);
        rememberBaseline(payload);
        writeSnapshot(targetWorldId, categoryId, payload);
        console.info("[canvas] 已下发画布数据", categoryId, entries.length, "条目", payload.connections.length, "连线");
        canvasInternals.setState({
          worldId: targetWorldId,
          categoryId,
          snapshot: payload,
          phase: "ready",
          message: `已载入 ${entries.length} 条`,
        });
      } catch (err) {
        console.error("[canvas] 加载失败", err);
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

  /**
   * 数据来源由 URL 决定：`?cat=<分类 id>` 指定要载入哪个分类的画布。
   *
   * 为什么不靠页面里的 dispatchCanvas：画布宿主是**常驻**的，页面组件的激活动作可能在
   * 宿主挂载之前就发出、或在挂载后丢失（表现为画布空白）。直接读 URL 最可靠，
   * 而且从条目列表点「画布」带过来的 cat / focus 参数也能一并处理。
   */
  useEffect(() => {
    if (!active || !worldId) {
      return;
    }
    const cat = new URLSearchParams(location.search).get("cat") ?? "";
    if (!cat) {
      return;
    }
    const current = canvasInternals.getState();
    if (current.worldId === worldId && current.categoryId === cat) {
      return;
    }
    void loadCanvas(worldId, cat);
  }, [active, worldId, location.search, loadCanvas]);

  /**
   * 从条目列表带过来的定位参数 `?focus=<条目 id>`：数据就绪后把该节点居中并高亮。
   * 每个 focus 值只处理一次，避免用户在画布上平移时被反复拉回。
   */
  const focusHandledRef = useRef("");
  /** 已经消费过「自动进入编辑页」的 focus 值：避免同一次跳转反复触发 */
  const editOpenedRef = useRef("");
  useEffect(() => {
    if (!active) {
      return;
    }
    const focusId = new URLSearchParams(location.search).get("focus") ?? "";
    if (!focusId || focusHandledRef.current === focusId) {
      return;
    }
    if (state.phase !== "ready") {
      return;
    }
    const frame = frameRef.current;
    if (!frame) {
      return;
    }
    focusHandledRef.current = focusId;
    frame.contentWindow?.postMessage({ type: "weave:focus", nodeId: focusId }, window.location.origin);

    // ?edit=1：来自「条目列表新建」的跳转——先让用户看到它在画布上的位置与详情浮层，
    // 再进入条目页写正文（节点即条目，正文仍在条目页编辑）。
    // 同一个 focus 只自动进一次，避免之后从条目行点「画布」时又被弹进编辑器。
    if (new URLSearchParams(location.search).get("edit") === "1" && editOpenedRef.current !== focusId) {
      editOpenedRef.current = focusId;
      const timer = window.setTimeout(() => {
        navigate(`/w/${worldId}/entries/${focusId}/edit`);
      }, 600);
      return () => window.clearTimeout(timer);
    }
  }, [active, state.phase, location.search, navigate, worldId]);

  // 页面下发的动作（重新载入 / 停用）
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
        setBridgeReady(true);
        const pending = pendingPayloadRef.current;
        const pendingCategory = pendingCategoryRef.current;
        pendingPayloadRef.current = null;
        pendingCategoryRef.current = "";
        if (pending) {
          // 桥晚于数据就绪：把挂起的画布数据补发过去
          pushToCanvas(pending, pendingCategory);
        }
        // 无论有没有挂起数据，都确保当前分类已加载（重复调用由 loadCanvas 内部去重）
        const current = canvasInternals.getState();
        if (current.worldId && current.categoryId) {
          void loadCanvas(current.worldId, current.categoryId);
        }
        return;
      }
      if (data.type === "weave:change" && data.payload) {
        // 只读状态（未登录/无权限）下不做任何写回：改动只在本地画布上，刷新即还原
        if (statusLockedRef.current) {
          canvasInternals.setState({ message: "只读：登录后才能保存改动" });
          return;
        }
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
        // 可编辑时双击直接进**编辑页**写作；只读时进**阅读页**（没有编辑权限，不给编辑器入口）
        const current = canvasInternals.getState();
        const suffix = statusLockedRef.current ? "" : "/edit";
        navigate(`/w/${current.worldId}/entries/${data.nodeId}${suffix}`);
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

  /**
   * 画布激活期间禁止整个页面滚动。
   *
   * 画布是满屏的固定工作区，页面级滚动没有任何用处；而「顶栏高度 + 画布高度」这种
   * 两个 vh 相减的算法，在浏览器地址栏收放、页面缩放时会差 1~2px，就冒出一条没意义的页面滚动条。
   * 这里不去追求算准高度，直接关掉页面滚动——布局仍按 100vh 计算，不会裁剪内容。
   */
  useEffect(() => {
    document.body.classList.toggle("canvas-route", active);
    return () => document.body.classList.remove("canvas-route");
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

  /**
   * 首次加载期间用遮罩盖住画布，等桥就绪后再淡入。
   * 否则会先看到 Weave 自己渲染的那一瞬（用户反馈的「显示没修改的 Weave 界面」）。
   * 遮罩文字带上当前状态，让等待有解释。
   */
  const veilText = state.phase === "local" ? "正在显示本地缓存，随后拉取最新数据…" : "正在打开画布…";

  return (
    <div className={`canvas-host${active ? " is-active" : ""}`} aria-hidden={!active}>
      <iframe
        ref={frameRef}
        className={`canvas-frame${bridgeReady ? " is-ready" : ""}`}
        // 带构建期版本戳：同一构建内刷新会命中 HTTP 缓存（不再整包重下），新构建自动取新
        src={`/weave/weave.html?v=${__CANVAS_VERSION__}`}
        title="画布编辑器"
        allow="clipboard-write"
        onLoad={() => setFrameReady(true)}
      />
      {(state.phase === "loading" || (state.phase === "local" && !bridgeReady)) && (
        <div className="canvas-veil">
          <span>{veilText}</span>
        </div>
      )}
    </div>
  );
}

declare const __CANVAS_VERSION__: string;

export { dispatchCanvas };
