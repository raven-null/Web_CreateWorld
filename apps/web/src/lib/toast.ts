/** 轻提示类型 */
export type ToastType = "success" | "error" | "warning" | "info";

/** 一条轻提示 */
export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

/** 通知所有订阅者当前提示列表 */
function emit(): void {
  for (const listener of listeners) {
    listener(toasts);
  }
}

/**
 * 显示一条轻提示（右上角浮层，默认 3.5 秒后自动消失）。
 * @param type 提示类型
 * @param message 中文提示文案
 * @param durationMs 展示时长（毫秒）
 */
export function showToast(type: ToastType, message: string, durationMs = 3500): void {
  const item: ToastItem = { id: nextId++, type, message };
  toasts = [...toasts, item];
  emit();
  window.setTimeout(() => dismissToast(item.id), durationMs);
}

/**
 * 手动关闭一条提示（点击浮层时调用）。
 * @param id 提示 id
 */
export function dismissToast(id: number): void {
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}

/**
 * 订阅提示列表变化（供 ToastHost 组件使用）。
 * @param listener 变化回调
 * @returns 取消订阅函数
 */
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
