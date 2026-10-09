/**
 * 撤销 / 重做栈（方案 §9.2）。
 *
 * 记录方式是**差异块**而不是整层快照：一次笔画只保存它覆盖的矩形区域
 * （前后两份像素），因此 30 步历史的内存占用与笔刷大小相关，而不是与白板大小相关。
 *
 * 一次 `pointerdown → pointerup` 合并为一步：笔画途中的每个落点只更新
 * 当前步骤的矩形外接范围，不产生碎步。
 */
import type { PixelRect } from "./tile-store";

/** 一步历史：某矩形区域的前后两份像素数据 */
export interface HistoryEntry {
  /** 描述（用于调试与界面提示，如「笔刷」「橡皮」） */
  label: string;
  rect: PixelRect;
  before: Uint8Array;
  after: Uint8Array;
}

/** 历史栈默认深度（方案 §9.2：30 步） */
export const DEFAULT_HISTORY_LIMIT = 30;

/**
 * 撤销 / 重做栈。
 *
 * 用法：`begin()` 开始一步 → `record(...)` 记录受影响的区域
 * → `commit()` 结束该步；或 `abort()` 放弃（没有实际改动时）。
 */
export class HistoryStack {
  private readonly past: HistoryEntry[] = [];
  private readonly future: HistoryEntry[] = [];
  private readonly limit: number;
  private pending: { label: string; rect: PixelRect | null; before: Uint8Array | null; after: Uint8Array | null } | null =
    null;

  constructor(limit = DEFAULT_HISTORY_LIMIT) {
    this.limit = Math.max(1, limit);
  }

  /** 可撤销步数 */
  get undoCount(): number {
    return this.past.length;
  }

  /** 可重做步数 */
  get redoCount(): number {
    return this.future.length;
  }

  /**
   * 开始一步（一次笔画）。
   * @param label 步骤描述
   */
  begin(label: string): void {
    this.pending = { label, rect: null, before: null, after: null };
  }

  /**
   * 记录一次落点对区域的影响。
   *
   * `before` 与 `after` 由调用方负责读取（栈只负责保存与回放）。
   * @param rect 受影响矩形
   * @param before 修改前的像素
   * @param after 修改后的像素
   */
  record(rect: PixelRect, before: Uint8Array, after: Uint8Array): void {
    if (!this.pending) {
      return;
    }
    this.pending.rect = rect;
    this.pending.before = before;
    this.pending.after = after;
  }

  /**
   * 结束一步并入栈。
   * 没有任何记录（例如在画布外落笔）时自动丢弃，避免产生空步。
   */
  commit(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || !pending.rect || !pending.before || !pending.after) {
      return;
    }
    this.past.push({
      label: pending.label,
      rect: pending.rect,
      before: pending.before,
      after: pending.after,
    });
    // 新操作让「重做」失效
    this.future.length = 0;
    while (this.past.length > this.limit) {
      this.past.shift();
    }
  }

  /** 放弃当前步（例如落笔落在画布外） */
  abort(): void {
    this.pending = null;
  }

  /** 清空全部历史（如换地图、重新载入栅格时） */
  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
    this.pending = null;
  }

  /**
   * 取出一层用于撤销（不改栈，由调用方决定何时 `confirmUndo`）。
   * @returns 待撤销条目；没有可撤销内容时返回 null
   */
  peekUndo(): HistoryEntry | null {
    return this.past[this.past.length - 1] ?? null;
  }

  /** 确认撤销：把该步从 past 移到 future */
  confirmUndo(): void {
    const entry = this.past.pop();
    if (entry) {
      this.future.push(entry);
    }
  }

  /**
   * 取出一层用于重做（不改栈）。
   * @returns 待重做条目；没有可重做内容时返回 null
   */
  peekRedo(): HistoryEntry | null {
    return this.future[this.future.length - 1] ?? null;
  }

  /** 确认重做：把该步从 future 移回 past */
  confirmRedo(): void {
    const entry = this.future.pop();
    if (entry) {
      this.past.push(entry);
    }
  }
}
