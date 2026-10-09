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

/** 一步历史：某图层某矩形区域的前后两份像素数据 */
export interface HistoryEntry {
  /** 描述（用于调试与界面提示，如「笔刷」「橡皮」） */
  label: string;
  /** 属于哪个图层：多图层下撤销必须回到原图层 */
  layerId: string;
  /** 受影响区域（一次笔画 = 整条笔画的外接矩形） */
  rect: PixelRect;
  /** 该区域在**本步开始前**的像素 */
  before: Uint8Array;
  /** 该区域在**本步结束后**的像素 */
  after: Uint8Array;
}

/** 待入栈的一步（笔画进行中） */
interface PendingStep {
  label: string;
  layerId: string;
  /** 当前已覆盖区域的外接矩形 */
  bounds: PixelRect;
  /**
   * 开始前的像素：按**固定网格块**保存。
   *
   * 必须按固定网格而不是「每个落点一块」：相邻落点之间有空隙，
   * 只保存落点自身会在空隙处留下空洞（撤销时把地形抹掉）。
   * 按网格分块后，每个块第一次被碰到时就整块快照，块内绝对完整。
   */
  beforeChunks: Map<string, { rect: PixelRect; data: Uint8Array }>;
}

/** 网格块边长（与瓦片一致：一屏笔画通常只涉及 1~4 块） */
const CHUNK_SIZE = 256;

/** 从仓库读取一块矩形像素（`commit` 时用来取结束状态快照） */
export type RectReader = (rect: PixelRect) => Uint8Array;

/**
 * 把 b 合并进 a，返回二者的外接矩形（把 a 看作「左上角 + 宽高」）。
 * @param a 原矩形
 * @param b 待并入的矩形
 * @returns 合并后的外接矩形
 */
function unionRect(a: PixelRect, b: PixelRect): PixelRect {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 把矩形对齐到网格块（向外扩到块边界）。
 * @param rect 原矩形
 * @returns 对齐后的矩形
 */
function alignToChunk(rect: PixelRect): PixelRect {
  const x = Math.floor(rect.x / CHUNK_SIZE) * CHUNK_SIZE;
  const y = Math.floor(rect.y / CHUNK_SIZE) * CHUNK_SIZE;
  const right = Math.ceil((rect.x + rect.width) / CHUNK_SIZE) * CHUNK_SIZE;
  const bottom = Math.ceil((rect.y + rect.height) / CHUNK_SIZE) * CHUNK_SIZE;
  return { x, y, width: right - x, height: bottom - y };
}

/** 从若干分块快照拼出整块矩形的像素（未覆盖到的位置填 0） */
function blitChunks(
  bounds: PixelRect,
  chunks: Iterable<{ rect: PixelRect; data: Uint8Array }>,
): Uint8Array {
  const out = new Uint8Array(bounds.width * bounds.height);
  for (const chunk of chunks) {
    // 分块可能比目标区域大（网格对齐会外扩），逐行逐列裁剪
    for (let row = 0; row < chunk.rect.height; row += 1) {
      const targetY = chunk.rect.y + row - bounds.y;
      if (targetY < 0 || targetY >= bounds.height) {
        continue;
      }
      const sourceRowStart = row * chunk.rect.width;
      const firstCol = Math.max(0, bounds.x - chunk.rect.x);
      const lastCol = Math.min(chunk.rect.width, bounds.x + bounds.width - chunk.rect.x);
      for (let col = firstCol; col < lastCol; col += 1) {
        const targetX = chunk.rect.x + col - bounds.x;
        out[targetY * bounds.width + targetX] = chunk.data[sourceRowStart + col] ?? 0;
      }
    }
  }
  return out;
}

/** 历史栈默认深度（方案 §9.2：30 步） */
export const DEFAULT_HISTORY_LIMIT = 30;

/**
 * 撤销 / 重做栈。
 *
 * 用法：`begin()` 开始一步 → `record(layerId, ...)` 记录受影响的区域
 * → `commit()` 结束该步；或 `abort()` 放弃（没有实际改动时）。
 *
 * 多图层注意：一步笔画只发生在一个图层上（用户绘制前已选定当前图层），
 * 因此记录里带上 layerId，撤销时回到那一层即可。
 */
export class HistoryStack {
  private readonly past: HistoryEntry[] = [];
  private readonly future: HistoryEntry[] = [];
  private readonly limit: number;
  private pending: PendingStep | null = null;

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
    this.pending = { label, layerId: "", bounds: { x: 0, y: 0, width: 0, height: 0 }, beforeChunks: new Map() };
  }

  /**
   * 记录一次落点影响到的区域（**累加**，不是覆盖）。
   *
   * 一次拖动会有几十个落点，若只记最后一个，撤销 / 重做就只回退笔画的末尾
   * ——用户看到的现象是「点了撤销 / 重做，画面几乎没变」。
   *
   * @param layerId 所在图层
   * @param rect 本次落点影响的矩形
   * @param reader 从仓库读取像素的函数（由调用方提供，栈不接触数据源）
   */
  record(layerId: string, rect: PixelRect, reader: RectReader): void {
    const pending = this.pending;
    if (!pending || rect.width <= 0 || rect.height <= 0) {
      return;
    }
    pending.layerId = layerId;
    if (pending.bounds.width === 0 || pending.bounds.height === 0) {
      pending.bounds = rect;
    } else {
      pending.bounds = unionRect(pending.bounds, rect);
    }
    // 只在这里读「改动前」的像素：此刻本次落点还没写数据。
    // 按网格块缓存，同一块只读一次
    const chunk = alignToChunk(rect);
    const key = `${chunk.x}:${chunk.y}`;
    if (!pending.beforeChunks.has(key)) {
      pending.beforeChunks.set(key, { rect: chunk, data: reader(chunk) });
    }
  }

  /**
   * 结束一步并入栈。
   *
   * 结束状态（after）在**这一刻**统一读取，因此保存的是整条笔画真实结果；
   * 没有任何记录（例如在画布外落笔、或数据与改动前完全一致）时自动丢弃，避免空步。
   *
   * @param reader 从仓库读取像素的函数；不传则不会入栈
   */
  commit(reader?: RectReader): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.bounds.width <= 0 || pending.bounds.height <= 0 || !reader) {
      return;
    }
    const before = blitChunks(pending.bounds, pending.beforeChunks.values());
    const after = reader(pending.bounds);
    this.past.push({
      label: pending.label,
      layerId: pending.layerId,
      rect: pending.bounds,
      before,
      after,
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
