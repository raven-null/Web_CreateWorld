/**
 * 路由代码预取。
 *
 * 目的：侧边栏切换页面时**不出现等待**——懒加载页面的代码在后台提前下好，
 * 点击时直接从浏览器缓存取（构建产物带内容哈希 + immutable，缓存命中不受网络影响）。
 *
 * 为什么不影响首屏：预取在首屏渲染**完成之后**用 `requestIdleCallback`（无此 API 时退回
 * setTimeout）排队执行，而且都是独立的小 chunk（多数 2~12KB），不会与首屏资源抢带宽。
 *
 * 为什么不会报错：预取纯属优化，任何失败都静默忽略——真正点击时还会正常加载。
 */

/** 已排队或已完成的预取目标，避免重复触发 */
const prefetched = new Set<string>();

/**
 * 空闲时执行任务（不支持 requestIdleCallback 的环境退回 setTimeout）。
 * @param task 任务
 * @param delayMs 兜底延迟
 */
function runWhenIdle(task: () => void, delayMs = 1500): void {
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof idle === "function") {
    idle(task, { timeout: 3000 });
    return;
  }
  window.setTimeout(task, delayMs);
}

/**
 * 预取一组模块（按 key 去重，失败静默）。
 * @param key 去重键
 * @param loaders 模块加载函数
 */
function prefetchModules(key: string, loaders: Array<() => Promise<unknown>>): void {
  if (prefetched.has(key)) {
    return;
  }
  prefetched.add(key);
  runWhenIdle(() => {
    for (const load of loaders) {
      void load().catch(() => undefined);
    }
  });
}

/** 预取顶部导航与常用页面（登录后就能用到，与具体世界无关） */
export function prefetchCommonRoutes(): void {
  prefetchModules("common", [
    () => import("../pages/MyWorldsPage"),
    () => import("../pages/DraftsPage"),
    () => import("../pages/WorldPage"),
    () => import("../pages/SettingsPage"),
    () => import("../pages/NewWorldPage"),
  ]);
}

/**
 * 预取某个世界内的页面与数据。
 * 用户点进世界后，侧边栏那几项（画布 / 时间线 / 地图 / 搜索 / 设置）就能秒开。
 * @param worldId 世界 id
 */
export function prefetchWorldRoutes(worldId: string): void {
  if (!worldId) {
    return;
  }
  prefetchModules(`world:${worldId}`, [
    () => import("../pages/WorldCanvasPage"),
    () => import("../pages/WorldTimelinePage"),
    () => import("../pages/MapsPage"),
    () => import("../pages/SearchPage"),
    () => import("../pages/WorldSettingsPage"),
    () => import("../pages/EntryViewPage"),
  ]);
}
