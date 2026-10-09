/**
 * 撤销 / 重做栈（方案 §9.2）。
 *
 * 记录方式是**差异块**而不是整层快照：一次笔画只保存它覆盖的矩形区域
 * （前后两份像素），因此 30 步历史的内存占用与笔刷大小相关，而不是与白板大小相关。
 *
 * 一次 `pointerdown → pointerup` 合并为一步：笔画途中的每个落点只扩大
 * 当前步骤的覆盖范围，不产生碎步。
 *
 * ## 为什么要在开始时留一份基线
 *
 * 「改动前」的像素必须反映**笔画开始前**的状态。如果边画边取（碰到哪块取哪块），
 * 快速拖动时前后的落点会交错：某个块在第一次被碰到时，已经含有本次笔画前面落点
 * 画上去的内容，撤销后就会留下擦不掉的残块——用户看到的是「色块飘到别的地方」。
 *
 * 因此这里是**先快照、后绘制**：`begin()` 拿一份基线副本，`record()` 一律从基线取，
 * `commit()` 再从仓库取结束状态。
 */
import type { PixelRect } from "./tile-store";

/** 一步历史：某图层某矩形区域的前后两份像素数据 */
export interface HistoryEntry {
  /** 描述（用于调试与界面提示，如「笔刷」「橡皮」） */
  label: string;
  /** 属于哪个图层：多图层下撤销必须回到原图层 */
  layerId: string;
  /** 受影响区域（一次笔画 = 整条笔画的覆盖范围，按网格块对齐） */
  rect: PixelRect;
  /** 该区域在**本步开始前**的像素 */
  before: Uint8Array;
  /** 该区域在**本步结束后**的像素 */
  after: Uint8Array;
}

/** 从仓库读取一块矩形像素（`commit` 取结束状态、创建基线都用它） */
export type RectReader = (rect: PixelRect) => Uint8Array;

/**
 * 冻结一份「笔画开始前」的基线。
 *
 * 做法是**先整幅拷一份**：指针按下时就完成，之后无论怎么画，基线都不再变化。
 * 拷 2048×1024 只要 1ms 上下，换来的是「撤销一定还原成原样」这个确定结果。
 *
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @param read 从仓库读取像素
 * @returns 可直接交给 `HistoryStack.begin` 的基线
 */
export function createHistoryBaseline(
  boardWidth: number,
  boardHeight: number,
  read: RectReader,
): HistoryBaseline {
  const frozen = read({ x: 0, y: 0, width: boardWidth, height: boardHeight });
  return {
    x: 0,
    y: 0,
    width: boardWidth,
    height: boardHeight,
    read: (rect) => cropRect(
      { x: 0, y: 0, width: boardWidth, height: boardHeight, data: frozen },
      rect,
    ),
  };
}

/**
 * 一步开始时的基线：白板范围 + 一个「读开始前像素」的函数。
 *
 * 这个 `read` 读到的必须是**冻结内容**，不能随之后的绘制变化
 * （见 `createHistoryBaseline`）。否则撤销时那块还原不回去
 * ——用户看到的就是「色块飘到别处 / 擦不干净」。
 */
export interface HistoryBaseline {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 读取「开始前」某矩形的像素 */
  read: RectReader;
}

/** 待入栈的一步（笔画进行中） */
interface PendingStep {
  label: string;
  layerId: string;
  /** 当前已覆盖区域（按网格块对齐后的外接矩形） */
  bounds: PixelRect;
  /** 开始前的像素：按网格块从基线里裁，同一块只裁一次 */
  beforeChunks: Map<string, { rect: PixelRect; data: Uint8Array }>;
}

/** 网格块边长（与瓦片一致：一屏笔画通常只涉及 1~4 块） */
const CHUNK_SIZE = 256;

/** 历史栈默认深度（方案 §9.2：30 步） */
export const DEFAULT_HISTORY_LIMIT = 30;

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
 *
 * **必须对齐**：`before` 像素是按网格块存的，若范围用真实外接矩形，
 * 两者坐标原点不同，拼回来会整体平移
 * ——用户看到的现象就是「撤销之后色块飘到别的地方」。
 *
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

/**
 * 从一块带范围的像素里裁出一部分（越界处补 0）。
 *
 * 补 0 与 `RasterTileStore.readRect` 的约定一致：透明像素本来就是 0，
 * 而网格块会伸到白板边界之外。
 *
 * @param source 源：范围 + 像素
 * @param rect 要裁的区域
 * @returns 行优先的像素副本
 */
function cropRect(source: { x: number; y: number; width: number; height: number; data: Uint8Array }, rect: PixelRect): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height);
  for (let row = 0; row < rect.height; row += 1) {
    const sourceY = rect.y + row;
    if (sourceY < source.y || sourceY >= source.y + source.height) {
      continue;
    }
    for (let col = 0; col < rect.width; col += 1) {
      const sourceX = rect.x + col;
      if (sourceX < source.x || sourceX >= source.x + source.width) {
        continue;
      }
      out[row * rect.width + col] =
        source.data[(sourceY - source.y) * source.width + (sourceX - source.x)] ?? 0;
    }
  }
  return out;
}

/** 从若干分块拼出整块矩形的像素（未覆盖到的位置填 0） */
function blitChunks(bounds: PixelRect, chunks: Iterable<{ rect: PixelRect; data: Uint8Array }>): Uint8Array {
  const out = new Uint8Array(bounds.width * bounds.height);
  for (const chunk of chunks) {
    for (let row = 0; row < chunk.rect.height; row += 1) {
      const targetY = chunk.rect.y + row - bounds.y;
      if (targetY < 0 || targetY >= bounds.height) {
        continue;
      }
      const sourceRowStart = row * chunk.rect.width;
      for (let col = 0; col < chunk.rect.width; col += 1) {
        const targetX = chunk.rect.x + col - bounds.x;
        if (targetX < 0 || targetX >= bounds.width) {
          continue;
        }
        out[targetY * bounds.width + targetX] = chunk.data[sourceRowStart + col] ?? 0;
      }
    }
  }
  return out;
}

/**
 * 撤销 / 重做栈。
 *
 * 用法：`begin(label, baseline)` 开始一步（同时把开始前的整幅像素交进来）
 * → `record(layerId, rect)` 记录受影响的区域 → `commit(reader)` 结束该步；
 * 没有落点时用 `abort()` 放弃。
 *
 * 多图层注意：一步笔画只发生在一个图层上（用户绘制前已选定当前图层），
 * 因此记录里带上 layerId，撤销时回到那一层即可。
 */
export class HistoryStack {
  private readonly past: HistoryEntry[] = [];
  private readonly future: HistoryEntry[] = [];
  private readonly limit: number;
  private pending: PendingStep | null = null;
  /** 当前这一步开始时的基线 */
  private baseline: HistoryBaseline | null = null;

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
   * 开始一步，并接收「开始前」的基线。
   *
   * 基线必须在**第一次落笔之前**取好，否则会混进本次笔画的内容。
   *
   * @param label 步骤描述
   * @param baseline 开始前的基线（范围 + 读取函数）
   */
  begin(label: string, baseline: HistoryBaseline): void {
    this.baseline = baseline;
    this.pending = {
      label,
      layerId: "",
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      beforeChunks: new Map(),
    };
    // 立刻让基线冻结（此时还没落笔），之后怎么画都不会影响它
    baseline.read({ x: baseline.x, y: baseline.y, width: 0, height: 0 });
  }

  /**
   * 记录一次落点影响到的区域（**累加**，不是覆盖）。
   *
   * 一次拖动会有几十个落点，若只记最后一个，撤销 / 重做就只回退笔画的末尾
   * ——用户看到的现象是「点了撤销 / 重做，画面几乎没变」。
   *
   * 「改动前」的像素一律从基线裁取，与落点到来的顺序无关。
   *
   * @param layerId 所在图层
   * @param rect 本次落点影响的矩形
   */
  record(layerId: string, rect: PixelRect): void {
    const pending = this.pending;
    if (!pending || rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const chunk = alignToChunk(rect);
    pending.layerId = layerId;
    if (pending.bounds.width === 0 || pending.bounds.height === 0) {
      pending.bounds = chunk;
    } else {
      pending.bounds = unionRect(pending.bounds, chunk);
    }
    const key = `${chunk.x}:${chunk.y}`;
    if (pending.beforeChunks.has(key)) {
      return;
    }
    const baseline = this.baseline;
    // 基线缺失（调用方没给）时留空：宁可少还原，也不引入错位数据
    pending.beforeChunks.set(key, {
      rect: chunk,
      data: baseline ? baseline.read(chunk) : new Uint8Array(chunk.width * chunk.height),
    });
  }

  /**
   * 结束一步并入栈。
   *
   * 结束状态（after）在**这一刻**统一读取，因此保存的是整条笔画真实结果；
   * 没有任何落点（例如在画布外落笔）时自动丢弃，避免空步。
   *
   * @param reader 从仓库读取像素的函数；不传则不会入栈
   */
  commit(reader?: RectReader): void {
    const pending = this.pending;
    this.pending = null;
    this.baseline = null;
    if (!pending || pending.bounds.width <= 0 || pending.bounds.height <= 0 || !reader) {
      return;
    }
    const entry: HistoryEntry = {
      label: pending.label,
      layerId: pending.layerId,
      rect: pending.bounds,
      before: blitChunks(pending.bounds, pending.beforeChunks.values()),
      after: reader(pending.bounds),
    };
    this.past.push(entry);
    // 新操作让「重做」失效
    this.future.length = 0;
    while (this.past.length > this.limit) {
      this.past.shift();
    }
  }

  /** 放弃当前步（例如落笔落在画布外） */
  abort(): void {
    this.pending = null;
    this.baseline = null;
  }

  /** 清空全部历史（如换地图、重新载入栅格时） */
  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
    this.pending = null;
    this.baseline = null;
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
