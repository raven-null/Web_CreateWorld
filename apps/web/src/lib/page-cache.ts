/**
 * 页面数据的即时渲染缓存（stale-while-revalidate）。
 *
 * 用途：侧边栏切换页面时，先把**上次的数据**立刻渲染出来（几乎零等待），
 * 同时在后台请求最新数据并替换。这样点击「时间线 / 地图」这类页面不再出现整屏加载动画。
 *
 * 与 lib/weave-cache.ts 的分工：那个专用于画布（快照 + 节点坐标），
 * 这里是通用的只读页面数据缓存（时间线、地图列表等）。
 */
import { useEffect, useRef, useState } from "react";

/** 缓存有效期：超过则不再用于首屏渲染（避免显示过于陈旧的内容） */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** localStorage 键前缀 */
const PREFIX = "create-world:page-cache:";

/**
 * 读取页面数据缓存（同步，供 useState 初始化用）。
 * @param key 缓存键
 * @returns 缓存数据；无缓存或过期返回 null
 */
export function readPageCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`${PREFIX}${key}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { at: number; data: T };
    if (Date.now() - parsed.at > CACHE_TTL_MS) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * 写入页面数据缓存。
 * @param key 缓存键
 * @param data 数据
 */
export function writePageCache<T>(key: string, data: T): void {
  try {
    localStorage.setItem(`${PREFIX}${key}`, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // 隐私模式或容量不足：忽略，缓存只是优化
  }
}

/** useCachedResource 的返回结构 */
export interface CachedResource<T> {
  /** 数据（可能来自缓存） */
  data: T | null;
  /** 是否还没有任何数据可显示（有缓存时为 false，因此不会闪加载动画） */
  loading: boolean;
  /** 错误信息 */
  error: string;
  /** 重新请求 */
  reload: () => void;
  /** 本地更新数据（编辑后就地刷新展示，无需重新请求） */
  setData: (next: T) => void;
}

/**
 * 带缓存的只读数据加载：缓存立即上屏 + 后台刷新。
 * @param key 缓存键（例如 `timeline:${worldId}`）
 * @param load 加载函数（返回最新数据）
 * @returns 数据、加载态、错误与重新加载方法
 */
export function useCachedResource<T>(key: string, load: () => Promise<T>): CachedResource<T> {
  const [data, setData] = useState<T | null>(() => readPageCache<T>(key));
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  /** 保持 load 最新，避免把它放进依赖导致重复请求 */
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    loadRef
      .current()
      .then((fresh) => {
        if (!alive) {
          return;
        }
        setData(fresh);
        writePageCache(key, fresh);
        setError("");
      })
      .catch((err: Error) => {
        if (alive) {
          setError(err.message);
        }
      });
    return () => {
      alive = false;
    };
  }, [key, reloadToken]);

  return {
    data,
    // 有缓存时不算 loading：页面直接用旧数据渲染，避免闪加载动画
    loading: data === null && error === "",
    error,
    reload: () => setReloadToken((value) => value + 1),
    /** 本地更新：编辑后立即反映到界面，并顺手写回缓存 */
    setData: (next: T) => {
      setData(next);
      writePageCache(key, next);
    },
  };
}
