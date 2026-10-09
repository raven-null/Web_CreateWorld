/**
 * 图层门面：把「多图层」这层概念加在最前面，复用已经过测试的单图层仓库。
 *
 * 设计取舍：
 * - **每个栅格图层各自持有一份全幅索引栅格 + 自己的脏瓦片集合**
 *   （瓦片在服务端本身就是按 `layer_id` 分片存储的，这里与之对齐）
 * - 图层元信息（名称 / 类型 / 显隐 / 顺序 / 图例）走宿主的 `saveLayers`；
 *   宿主不实现该能力时退化为「仅内存」（能画能看，刷新后图层配置不保留）
 * - 本门面只做「多图层」的编排（取哪一层、写哪一层、谁该重绘），
 *   单层的编解码 / 脏瓦片 / 读写矩形仍然由 `RasterTileStore` 负责
 */
import type { MapHostAdapter, MapLayer, TerrainBrush } from "@worldmap/core";
import { terrainPaletteToUint32 } from "@worldmap/core";
import {
  RasterTileStore,
  TILE_SIZE,
  parseTileKey,
  tileKey,
  type PixelRect,
} from "./tile-store";

/** 栅格图层门面 */
export class MapLayerStore {
  /** 全部图层（含矢量图层；但只有栅格图层才有 store） */
  layers: MapLayer[] = [];
  /** 栅格图层的数据仓库：layerId → store */
  readonly rasterStores = new Map<string, RasterTileStore>();

  private readonly adapter: MapHostAdapter;
  private readonly mapId: string;
  private readonly width: number;
  private readonly height: number;
  private readonly revisions = { current: 0 };
  /** 地形调色板（转交给各图层的栅格仓库） */
  private readonly palette?: TerrainBrush[];

  constructor(options: {
    adapter: MapHostAdapter;
    mapId: string;
    width: number;
    height: number;
    layers: MapLayer[];
    revision: number;
    /** 地形调色板（决定索引 → 颜色；不传则用内置默认） */
    palette?: TerrainBrush[];
  }) {
    this.adapter = options.adapter;
    this.mapId = options.mapId;
    this.width = options.width;
    this.height = options.height;
    this.layers = [...options.layers].sort((a, b) => a.zIndex - b.zIndex);
    this.revisions.current = options.revision;
    this.palette = options.palette;
  }

  /** 白板宽高（供渲染与统计使用） */
  get boardSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /**
   * 全量载入所有栅格图层。
   * @returns 各图层载入的瓦片数之和
   */
  async load(): Promise<number> {
    let total = 0;
    for (const layer of this.layers) {
      if (layer.storage !== "raster") {
        continue;
      }
      if (this.rasterStores.has(layer.id)) {
        continue;
      }
      const store = new RasterTileStore({
        adapter: this.adapter,
        mapId: this.mapId,
        layerId: layer.id,
        width: this.width,
        height: this.height,
        ...(this.palette ? { palette: this.palette } : {}),
      });
      total += await store.load();
      this.rasterStores.set(layer.id, store);
    }
    return total;
  }

  /** 按 zIndex 升序、过滤出可见的栅格图层（渲染顺序即数组顺序） */
  visibleRasterLayers(): MapLayer[] {
    return this.layers
      .filter((layer) => layer.storage === "raster" && layer.visible)
      .sort((a, b) => a.zIndex - b.zIndex);
  }

  /** 全部栅格图层（含隐藏的，用于脏瓦片检查） */
  rasterLayers(): MapLayer[] {
    return this.layers.filter((layer) => layer.storage === "raster");
  }

  /**
   * 取某图层的数据仓库。
   * @param layerId 图层 id
   * @returns 仓库；不存在时返回 null
   */
  storeOf(layerId: string): RasterTileStore | null {
    return this.rasterStores.get(layerId) ?? null;
  }

  /** 当前有待保存瓦片的图层 id 列表 */
  dirtyLayerIds(): string[] {
    const result: string[] = [];
    for (const [layerId, store] of this.rasterStores) {
      if (store.dirtyCount > 0) {
        result.push(layerId);
      }
    }
    return result;
  }

  /** 全部图层的待保存瓦片总数 */
  totalDirtyCount(): number {
    let total = 0;
    for (const store of this.rasterStores.values()) {
      total += store.dirtyCount;
    }
    return total;
  }

  /**
   * 标记某图层的一个矩形区域为脏。
   * @param layerId 图层 id
   * @param rect 世界像素矩形
   */
  markDirty(layerId: string, rect: PixelRect): void {
    this.storeOf(layerId)?.markDirty(rect);
  }

  /**
   * 在某图层上写入矩形数据并标脏（撤销 / 重做用）。
   * @param layerId 图层 id
   * @param rect 矩形
   * @param data 行优先索引数据
   */
  writeRect(layerId: string, rect: PixelRect, data: Uint8Array): void {
    this.storeOf(layerId)?.writeRect(rect, data);
  }

  /**
   * 读取某图层矩形的数据。
   * @param layerId 图层 id
   * @param rect 矩形
   * @returns 行优先索引数据；图层不存在时返回 null
   */
  readRect(layerId: string, rect: PixelRect): Uint8Array | null {
    return this.storeOf(layerId)?.readRect(rect) ?? null;
  }

  /**
   * 取某像素处的调色板下标（吸管用），自上而下取第一个非透明值。
   * 这样「吸管吸到的是用户看到的那一层」，符合直觉。
   * @param worldX 世界像素 x
   * @param worldY 世界像素 y
   * @returns 调色板下标；都没有内容时返回 0
   */
  sampleTopDown(worldX: number, worldY: number): number {
    const ordered = this.visibleRasterLayers().reverse(); // 从上层往下找
    for (const layer of ordered) {
      const value = this.storeOf(layer.id)?.sampleAt(worldX, worldY) ?? 0;
      if (value !== 0) {
        return value;
      }
    }
    return 0;
  }

  /**
   * 把宿主返回的图层列表应用进来（保存成功后回写）。
   * @param layers 新图层列表
   */
  setLayers(layers: MapLayer[]): void {
    this.layers = [...layers].sort((a, b) => a.zIndex - b.zIndex);
  }

  /**
   * 新增图层：先在内存中生成，再交给宿主持久化。
   * @param input 名称与类型
   * @returns 新图层（已带 id 与 zIndex）；宿主未实现 saveLayers 时仍返回内存对象
   */
  async addLayer(input: { name: string; type: MapLayer["type"] }): Promise<MapLayer> {
    const maxZ = this.layers.reduce((max, layer) => Math.max(max, layer.zIndex), -1);
    const layer: MapLayer = {
      id: `layer-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name: input.name,
      type: input.type,
      // 首期新图层都是栅格（笔刷能直接画）；矢量类型留给后续
      storage: input.type === "labels" ? "vector" : "raster",
      visible: true,
      opacity: 1,
      zIndex: maxZ + 1,
      legend: [],
    };
    this.layers = [...this.layers, layer];
    if (layer.storage === "raster") {
      // 新图层从空白开始：建一个空仓库并载入（空的即全透明）
      const store = new RasterTileStore({
        adapter: this.adapter,
        mapId: this.mapId,
        layerId: layer.id,
        width: this.width,
        height: this.height,
        ...(this.palette ? { palette: this.palette } : {}),
      });
      await store.load();
      this.rasterStores.set(layer.id, store);
    }
    await this.persist();
    return layer;
  }

  /**
   * 更新图层属性（改名 / 显隐 / 透明度 / 顺序）。
   * @param layerId 图层 id
   * @param patch 待更新的字段
   * @returns 是否找到并更新
   */
  async updateLayer(
    layerId: string,
    patch: Partial<Pick<MapLayer, "name" | "visible" | "opacity" | "zIndex">>,
  ): Promise<boolean> {
    const layer = this.layers.find((item) => item.id === layerId);
    if (!layer) {
      return false;
    }
    Object.assign(layer, patch);
    this.layers = [...this.layers].sort((a, b) => a.zIndex - b.zIndex);
    await this.persist();
    return true;
  }

  /**
   * 删除图层（连同它的内存栅格一起丢弃；服务端数据由宿主删除接口处理）。
   * @param layerId 图层 id
   * @returns 是否删除成功
   */
  async removeLayer(layerId: string): Promise<boolean> {
    const before = this.layers.length;
    this.layers = this.layers.filter((layer) => layer.id !== layerId);
    if (this.layers.length === before) {
      return false;
    }
    this.rasterStores.delete(layerId);
    await this.persist();
    return true;
  }

  /**
   * 调整图层顺序：按传入的 id 顺序重排（数组首个为最底层）。
   * @param orderedIds 从底到顶的图层 id 列表
   */
  async reorder(orderedIds: string[]): Promise<void> {
    orderedIds.forEach((id, index) => {
      const layer = this.layers.find((item) => item.id === id);
      if (layer) {
        layer.zIndex = index;
      }
    });
    this.layers = [...this.layers].sort((a, b) => a.zIndex - b.zIndex);
    await this.persist();
  }

  /**
   * 把图层列表写回宿主。
   * 宿主未实现 `saveLayers` 时只更新内存（能画能看，配置不持久化）。
   */
  private async persist(): Promise<void> {
    if (!this.adapter.saveLayers) {
      return;
    }
    await this.adapter.saveLayers({ mapId: this.mapId, layers: this.layers });
  }

  /**
   * 汇总各图层待保存的瓦片并按图层分批。
   * @returns 每项为「某图层的一批瓦片」
   */
  async takeAllDirtyTiles(): Promise<{ layerId: string; tiles: Awaited<ReturnType<RasterTileStore["takeDirtyTiles"]>> }[]> {
    const result: { layerId: string; tiles: Awaited<ReturnType<RasterTileStore["takeDirtyTiles"]>> }[] = [];
    for (const [layerId, store] of this.rasterStores) {
      if (store.dirtyCount === 0) {
        continue;
      }
      result.push({ layerId, tiles: await store.takeDirtyTiles() });
    }
    return result;
  }

  // —— 离屏合成：每个栅格图层一块位图，绘制后按脏矩形局部更新 ——

  /**
   * 取（或创建）某图层的离屏位图。
   * @param layerId 图层 id
   * @returns 离屏画布；图层不存在时返回 null
   */
  bitmapOf(layerId: string): HTMLCanvasElement | null {
    const store = this.storeOf(layerId);
    if (!store) {
      return null;
    }
    let canvas = this.bitmaps.get(layerId);
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = this.width;
      canvas.height = this.height;
      this.bitmaps.set(layerId, canvas);
      this.redrawBitmap(layerId, { x: 0, y: 0, width: this.width, height: this.height });
    }
    return canvas;
  }

  /**
   * 按矩形局部重画某图层的离屏位图（绘制后只更新脏区域）。
   * @param layerId 图层 id
   * @param rect 世界像素矩形
   */
  refreshBitmap(layerId: string, rect: PixelRect): void {
    this.redrawBitmap(layerId, rect);
  }

  /** 整层重画（载入完成、撤销之后使用） */
  redrawAllBitmaps(): void {
    for (const layerId of this.rasterStores.keys()) {
      this.redrawBitmap(layerId, { x: 0, y: 0, width: this.width, height: this.height });
    }
  }

  /**
   * 把可见栅格图层按顺序合成到目标上下文。
   *
   * 透明度用 `globalAlpha` 近似（单图层自身的叠加行为会略有差异，
   * 但避免了「每像素混合」的高开销；精确逐像素混合留给后续优化）。
   *
   * @param context 目标 2D 上下文
   * @param offsetX 视口左上角的世界 x
   * @param offsetY 视口左上角的世界 y
   * @param zoom 缩放倍数
   * @param pixelRatio 设备像素比（用于线条等按物理像素对齐）
   */
  renderTo(
    context: CanvasRenderingContext2D,
    offsetX: number,
    offsetY: number,
    zoom: number,
    pixelRatio: number,
  ): void {
    void pixelRatio;
    context.imageSmoothingEnabled = zoom < 1;
    for (const layer of this.visibleRasterLayers()) {
      const bitmap = this.bitmapOf(layer.id);
      if (!bitmap) {
        continue;
      }
      context.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
      context.drawImage(bitmap, -offsetX * zoom, -offsetY * zoom, bitmap.width * zoom, bitmap.height * zoom);
    }
    context.globalAlpha = 1;
  }

  /** 把某图层当前栅格整块写进离屏位图；rect 只用于减少写入量 */
  private redrawBitmap(layerId: string, rect: PixelRect): void {
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const store = this.storeOf(layerId);
    const canvas = this.bitmaps.get(layerId);
    if (!store || !canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.putImageData(
      buildImageDataFromStore(store, rect),
      rect.x,
      rect.y,
    );
  }

  /** 离屏位图：layerId → canvas */
  private readonly bitmaps = new Map<string, HTMLCanvasElement>();
}

/**
 * 从瓦片键还原「图层内的像素矩形」，用于草稿写回时标脏。
 * @param keys 瓦片键列表
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @returns 覆盖这些瓦片的像素矩形
 */
export function rectFromTileKeys(keys: string[], boardWidth: number, boardHeight: number): PixelRect {
  if (keys.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let minCol = Number.POSITIVE_INFINITY;
  let minRow = Number.POSITIVE_INFINITY;
  let maxCol = Number.NEGATIVE_INFINITY;
  let maxRow = Number.NEGATIVE_INFINITY;
  for (const key of keys) {
    const coord = parseTileKey(key);
    minCol = Math.min(minCol, coord.col);
    minRow = Math.min(minRow, coord.row);
    maxCol = Math.max(maxCol, coord.col);
    maxRow = Math.max(maxRow, coord.row);
  }
  const x = Math.max(0, minCol * TILE_SIZE);
  const y = Math.max(0, minRow * TILE_SIZE);
  const right = Math.min(boardWidth, (maxCol + 1) * TILE_SIZE);
  const bottom = Math.min(boardHeight, (maxRow + 1) * TILE_SIZE);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** 导出瓦片键工具，供其它模块复用 */
export { tileKey };

/**
 * 从仓库的全幅栅格构建某矩形的 ImageData（用 Uint32 视图一次写入）。
 *
 * 索引 0（透明）写为全 0：合成时该处不会覆盖下层的颜色。
 *
 * @param store 栅格仓库
 * @param rect 世界像素矩形
 * @returns ImageData
 */
function buildImageDataFromStore(store: RasterTileStore, rect: PixelRect): ImageData {
  const table = terrainPaletteToUint32(store.palette);
  const rgba = new Uint8ClampedArray(new ArrayBuffer(rect.width * rect.height * 4));
  const view = new Uint32Array(rgba.buffer);
  for (let row = 0; row < rect.height; row += 1) {
    const sourceStart = (rect.y + row) * store.width + rect.x;
    const targetStart = row * rect.width;
    for (let col = 0; col < rect.width; col += 1) {
      const value = store.indices[sourceStart + col] ?? 0;
      if (value === 0) {
        continue;
      }
      const packed = table[value];
      view[targetStart + col] = packed === undefined ? 0xff000000 : packed | 0xff000000;
    }
  }
  return new ImageData(rgba, rect.width, rect.height);
}
