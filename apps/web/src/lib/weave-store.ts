/**
 * 画布 store：画布宿主组件（CanvasHost）与画布页面之间的状态中枢。
 *
 * 为什么需要它：
 *   1. 画布 iframe 需要**常驻**（放在世界区布局里，切页面不销毁），而分类切换、重新载入这些操作
 *      发生在页面 UI 里——两者不在同一棵组件树，用一个模块级 store + 订阅解决；
 *   2. 加载要「快」：先用本地快照即刻上屏，再拉最新数据替换（stale-while-revalidate）；
 *   3. 同步（差异合并写回数据库）逻辑复杂，集中在这里，组件只负责展示。
 */
import { useEffect, useState } from "react";

/** Weave 存档中的节点 */
export interface WeaveNode {
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
export interface WeaveConnection {
  id: string;
  from: string;
  to: string;
  label?: string;
  [key: string]: unknown;
}

/** Weave 存档中的分区 */
export interface WeaveRegion {
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
export interface WeavePayload {
  nodes: WeaveNode[];
  connections: WeaveConnection[];
  regions?: WeaveRegion[];
  viewport?: { panX: number; panY: number; scale: number };
}

/** 画布 store 对外暴露的状态 */
export interface CanvasState {
  /** 当前世界 id */
  worldId: string;
  /** 当前分类 id */
  categoryId: string;
  /** 热快照：本次会话已经载入过的画布（按分类），用于切换时立即上屏 */
  snapshot: WeavePayload | null;
  /** 载入阶段：local=先用本地缓存的旧数据展示，fresh=已是最新数据 */
  phase: "idle" | "loading" | "local" | "syncing" | "ready" | "error";
  /** 提示文案 */
  message: string;
}

/** 页面可以下发给 store 的动作 */
export type CanvasAction =
  | { type: "activate"; worldId: string; categoryId: string }
  | { type: "reload" }
  | { type: "deactivate" };

type Listener = () => void;

const INITIAL_STATE: CanvasState = {
  worldId: "",
  categoryId: "",
  snapshot: null,
  phase: "loading",
  message: "正在加载…",
};

/** 模块级单例状态：iframe 常驻与页面 UI 之间共享 */
let state: CanvasState = INITIAL_STATE;
const listeners = new Set<Listener>();

/** 发布新状态并通知订阅者 */
function setState(patch: Partial<CanvasState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    listener();
  }
}

/** 订阅状态变化（供 useSyncExternalStore 使用） */
export function subscribeCanvas(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 读取当前状态 */
export function getCanvasState(): CanvasState {
  return state;
}

/**
 * 组件侧订阅 store 的钩子。
 * @returns 当前画布状态
 */
export function useCanvasState(): CanvasState {
  const [value, setValue] = useState<CanvasState>(state);
  useEffect(() => subscribeCanvas(() => setValue(state)), []);
  return value;
}

/** 内部动作派发口：CanvasHost 注册实现，页面调用 */
let actionHandler: ((action: CanvasAction) => void) | null = null;

/**
 * 由 CanvasHost 注册动作处理器（宿主挂载时注册，卸载时清空）。
 * @param handler 处理器
 * @returns 注销函数
 */
export function registerCanvasActionHandler(handler: (action: CanvasAction) => void): () => void {
  actionHandler = handler;
  return () => {
    if (actionHandler === handler) {
      actionHandler = null;
    }
  };
}

/**
 * 页面调用：下发动作给画布宿主。
 * @param action 动作
 */
export function dispatchCanvas(action: CanvasAction): void {
  actionHandler?.(action);
}

/** store 内部使用：整体更新状态（供 CanvasHost 使用） */
export const canvasInternals = { setState, getState: getCanvasState };
