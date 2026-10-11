/**
 * 画布本地缓存：分类切换与页面往返时用来「立刻上屏」，避免每次都等接口。
 *
 * 两层缓存：
 *   1. 内存缓存（模块级 Map）：本次会话内切换分类、切页面回来，立即拿到画布内容；
 *   2. localStorage：跨会话保留画布快照与节点坐标；
 *   3. sessionStorage：作为 IndexedDB 之外的廉价持久层，浏览器标签关闭即清空，
 *      用来在「刷新页面」时也能立即上屏。
 *
 * 缓存只是展示用的副本，权威数据始终在数据库；拉到最新数据后会覆盖。
 */
import type { WeavePayload } from "./weave-store";

/** 坐标缓存：条目 id → 位置与尺寸 */
export type LayoutCache = Record<string, { x: number; y: number; w?: number; h?: number }>;

/** 内存快照：key = `${worldId}:${categoryId}` */
const memorySnapshot = new Map<string, WeavePayload>();

/** 组装缓存键 */
function cacheKey(worldId: string, categoryId: string): string {
  return `${worldId}:${categoryId}`;
}

/** localStorage 键：画布快照 */
function snapshotKey(worldId: string, categoryId: string): string {
  return `create-world:canvas-snapshot:${worldId}:${categoryId}`;
}

/** localStorage 键：节点坐标 */
function layoutKey(worldId: string, categoryId: string): string {
  return `create-world:canvas-layout:${worldId}:${categoryId}`;
}

/**
 * 读画布快照：优先内存，其次 sessionStorage，最后 localStorage。
 * @param worldId 世界 id
 * @param categoryId 分类 id
 * @returns 画布存档或 null
 */
export function readSnapshot(worldId: string, categoryId: string): WeavePayload | null {
  const key = cacheKey(worldId, categoryId);
  const cached = memorySnapshot.get(key);
  if (cached) {
    return cached;
  }
  for (const storage of [safeSession(), safeLocal()]) {
    if (!storage) {
      continue;
    }
    try {
      const raw = storage.getItem(snapshotKey(worldId, categoryId));
      if (!raw) {
        continue;
      }
      const payload = JSON.parse(raw) as WeavePayload;
      if (Array.isArray(payload?.nodes)) {
        memorySnapshot.set(key, payload);
        return payload;
      }
    } catch {
      // 缓存损坏时忽略，走接口加载
    }
  }
  return null;
}

/**
 * 写画布快照：同时更新内存与两侧存储。
 * @param worldId 世界 id
 * @param categoryId 分类 id
 * @param payload 画布存档
 */
export function writeSnapshot(worldId: string, categoryId: string, payload: WeavePayload): void {
  memorySnapshot.set(cacheKey(worldId, categoryId), payload);
  const serialized = JSON.stringify(payload);
  for (const storage of [safeLocal(), safeSession()]) {
    try {
      storage?.setItem(snapshotKey(worldId, categoryId), serialized);
    } catch {
      // 容量不足或隐私模式：忽略，缓存不是必需品
    }
  }
}

/**
 * 读节点坐标缓存。
 * @param worldId 世界 id
 * @param categoryId 分类 id
 * @returns 坐标表
 */
export function readLayout(worldId: string, categoryId: string): LayoutCache {
  try {
    const raw = safeLocal()?.getItem(layoutKey(worldId, categoryId));
    return raw ? (JSON.parse(raw) as LayoutCache) : {};
  } catch {
    return {};
  }
}

/**
 * 写节点坐标：只存位置与尺寸，不存标题等易变内容。
 * @param worldId 世界 id
 * @param categoryId 分类 id
 * @param payload 画布存档
 */
export function writeLayout(worldId: string, categoryId: string, payload: WeavePayload): void {
  try {
    const layout: LayoutCache = {};
    for (const node of payload.nodes) {
      layout[node.id] = { x: node.x, y: node.y, w: node.w, h: node.h };
    }
    safeLocal()?.setItem(layoutKey(worldId, categoryId), JSON.stringify(layout));
  } catch {
    // 忽略：坐标缓存丢失只会导致下次落位回到网格布局
  }
}

/** 取 localStorage（不可用时返回 null，如隐私模式） */
function safeLocal(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 取 sessionStorage（不可用时返回 null） */
function safeSession(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
