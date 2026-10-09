/**
 * 标记（marker）仓库：把宿主已有的标记与画布打通。
 *
 * 坐标约定：插件内部一律用**世界像素**绘制，而标记在宿主侧存的是
 * **0~1 的平面归一化坐标**（`x = lonLatToUv().u`、`y = lonLatToUv().v`）。
 * 两种表示之间的换算集中在本文件，避免散落各处。
 *
 * 说明：标记列表走的是**主站既有接口**（`GET /maps/:mapId`），
 * 因此不需要为画布新增任何标记接口；这也符合「换宿主只改适配器」的分工。
 */
import type { HostMarker, MapHostAdapter } from "@worldmap/core";

/** 画布上的一个标记 */
export interface CanvasMarker {
  id: string;
  /** 世界像素坐标 */
  x: number;
  y: number;
  /** 归一化坐标（0~1），写回宿主时用 */
  u: number;
  v: number;
  label: string;
  /** 宿主侧关联标识（主站放条目 id），插件只当作不透明字符串 */
  linkRef: string | null;
  /** 关联对象的显示名（用于气泡与列表） */
  linkLabel: string | null;
}

/**
 * 标记仓库。
 *
 * 用法：`await store.load()` 拉取列表 → 画布按 `markers` 绘制
 * → 拖动 / 删除时调用对应方法（宿主成功后再更新内存）。
 */
export class MarkerStore {
  private items: CanvasMarker[] = [];
  private readonly adapter: MapHostAdapter;
  private readonly mapId: string;
  private readonly boardWidth: number;
  private readonly boardHeight: number;
  /** 保存位置时用的版本号（宿主不要求，但传上更安全） */
  private revision: number;

  constructor(options: {
    adapter: MapHostAdapter;
    mapId: string;
    boardWidth: number;
    boardHeight: number;
    revision: number;
  }) {
    this.adapter = options.adapter;
    this.mapId = options.mapId;
    this.boardWidth = options.boardWidth;
    this.boardHeight = options.boardHeight;
    this.revision = options.revision;
  }

  /** 当前标记列表（只读快照） */
  get markers(): CanvasMarker[] {
    return this.items;
  }

  /**
   * 从宿主拉取标记列表。
   * 适配器未实现标记能力时返回空列表（缺接口只少能力，不影响绘制）。
   * @returns 标记数量
   */
  async load(): Promise<number> {
    if (!this.adapter.loadMarkers) {
      this.items = [];
      return 0;
    }
    const raw = await this.adapter.loadMarkers(this.mapId);
    this.items = raw.map((row) => fromHostMarker(row, this.boardWidth, this.boardHeight));
    return this.items.length;
  }

  /**
   * 命中测试：找出落在指定世界像素点附近（半径内）的标记。
   * 后加载的标记在上层，因此从后往前找。
   * @param worldX 世界像素 x
   * @param worldY 世界像素 y
   * @param radiusPx 命中半径（世界像素）
   * @returns 命中的标记；没有则返回 null
   */
  hitTest(worldX: number, worldY: number, radiusPx: number): CanvasMarker | null {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const marker = this.items[i];
      if (!marker) {
        continue;
      }
      if (Math.hypot(marker.x - worldX, marker.y - worldY) <= radiusPx) {
        return marker;
      }
    }
    return null;
  }

  /**
   * 移动标记（先改内存用于即时反馈，再由 `persistPosition` 写回宿主）。
   * @param id 标记 id
   * @param worldX 新的世界像素 x
   * @param worldY 新的世界像素 y
   */
  moveTo(id: string, worldX: number, worldY: number): void {
    const marker = this.items.find((item) => item.id === id);
    if (!marker) {
      return;
    }
    const clampedX = clamp(worldX, 0, this.boardWidth);
    const clampedY = clamp(worldY, 0, this.boardHeight);
    marker.x = clampedX;
    marker.y = clampedY;
    marker.u = clampedX / this.boardWidth;
    marker.v = clampedY / this.boardHeight;
  }

  /**
   * 把标记位置写回宿主。
   * @param id 标记 id
   * @returns 是否保存成功（宿主未实现则视为无需保存）
   */
  async persistPosition(id: string): Promise<boolean> {
    const marker = this.items.find((item) => item.id === id);
    if (!marker) {
      return false;
    }
    if (!this.adapter.saveMarkerPosition) {
      return false;
    }
    await this.adapter.saveMarkerPosition({ mapId: this.mapId, markerId: id, u: marker.u, v: marker.v });
    return true;
  }

  /**
   * 新增标记。
   * @param worldX 世界像素 x
   * @param worldY 世界像素 y
   * @param label 标记名称
   * @param linkRef 关联标识（可空）
   * @returns 新建的标记；宿主未实现或失败时返回 null
   */
  async create(worldX: number, worldY: number, label: string, linkRef: string | null): Promise<CanvasMarker | null> {
    if (!this.adapter.createMarker) {
      return null;
    }
    const u = clamp(worldX, 0, this.boardWidth) / this.boardWidth;
    const v = clamp(worldY, 0, this.boardHeight) / this.boardHeight;
    const created = await this.adapter.createMarker({ mapId: this.mapId, u, v, label, linkRef });
    if (!created) {
      return null;
    }
    const marker: CanvasMarker = {
      id: created.id,
      x: u * this.boardWidth,
      y: v * this.boardHeight,
      u,
      v,
      label,
      linkRef,
      linkLabel: null,
    };
    this.items.push(marker);
    return marker;
  }

  /**
   * 删除标记。
   * @param id 标记 id
   * @returns 是否删除成功
   */
  async remove(id: string): Promise<boolean> {
    if (!this.adapter.deleteMarker) {
      return false;
    }
    await this.adapter.deleteMarker({ mapId: this.mapId, markerId: id });
    this.items = this.items.filter((item) => item.id !== id);
    return true;
  }

  /** 更新保存位置时携带的版本号 */
  setRevision(revision: number): void {
    this.revision = revision;
  }

  /** 当前版本号 */
  get currentRevision(): number {
    return this.revision;
  }
}

/**
 * 宿主的标记行 → 画布标记。
 * @param row 宿主返回的行
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @returns 画布标记
 */
function fromHostMarker(row: HostMarker, boardWidth: number, boardHeight: number): CanvasMarker {
  return {
    id: row.id,
    x: row.u * boardWidth,
    y: row.v * boardHeight,
    u: row.u,
    v: row.v,
    label: row.label,
    linkRef: row.linkRef ?? null,
    linkLabel: row.linkLabel ?? null,
  };
}

/**
 * 数值区间限制。
 * @param value 输入
 * @param min 下限
 * @param max 上限
 * @returns 限制后的值
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
