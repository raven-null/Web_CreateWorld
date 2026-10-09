/**
 * 瓦片仓库：全幅索引栅格、脏瓦片收集与 cwt1 编解码封装。
 *
 * 首期的取舍：**一次性把栅格图层读进内存**（2048×1024 单层约 2MB，
 * 一个瓦片几 KB，64KB 上限），换来最直接的绘制与撤销实现。
 * 方案里预留的「按需懒加载瓦片」留到白板上到 8192 以上时再做
 * （那时单层 32MB，不再适合全量驻留）。
 *
 * 本模块属于插件内部：只依赖 `@worldmap/core` 与宿主适配器契约，
 * 不碰 DOM（渲染在 MapEditor 里做），因此可以单独测试。
 */
import {
  CWT1_HEADER_BYTES,
  DEFAULT_TERRAIN_PALETTE,
  decodeTile,
  encodeTile,
  type GzipCompressor,
  type GzipDecompressor,
  type MapHostAdapter,
  type TerrainBrush,
  type Tile,
  type TileCoord,
} from "@worldmap/core";

/** 瓦片边长（与主站后端一致） */
export const TILE_SIZE = 256;

/** 脏瓦片集合（键为 "col:row"） */
export type DirtyTileSet = Set<string>;

/** 笔画覆盖的像素矩形（世界像素坐标） */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 瓦片坐标键 */
export function tileKey(col: number, row: number): string {
  return `${col}:${row}`;
}

/** 从键还原瓦片坐标 */
export function parseTileKey(key: string): TileCoord {
  const [colText, rowText] = key.split(":");
  return { col: Number(colText), row: Number(rowText) };
}

/**
 * 栅格图层仓库。
 *
 * 用法：`await store.load()` 全量载入 → 绘制时改 `store.indices` 并 `markDirty`
 * → 保存时 `takeDirtyTiles()` 取待提交瓦片 → 成功后 `clearDirty()`。
 */
export class RasterTileStore {
  readonly width: number;
  readonly height: number;
  /** 全幅调色板索引栅格，行优先 */
  readonly indices: Uint8Array;
  /** 地形调色板 */
  readonly palette: TerrainBrush[];

  private readonly dirty: DirtyTileSet = new Set();
  private readonly mapId: string;
  private readonly layerId: string;
  private readonly adapter: MapHostAdapter;
  private readonly compressor: GzipCompressor | null;
  private readonly decompressor: GzipDecompressor | null;
  /**
   * 各瓦片**初次载入时**的内容快照，用于判断「内容是否真的变了」。
   *
   * 必须用初始快照而不是「上次提交后」的状态：否则「涂一笔 → 撤销 → 又被标记为脏」
   * 这种情况会被误判成有改动，白白上传一遍（用户看到的则是无意义的上传与版本号增长）。
   */
  private readonly baselineTiles = new Map<string, Uint8Array>();

  constructor(options: {
    adapter: MapHostAdapter;
    mapId: string;
    layerId: string;
    width: number;
    height: number;
    palette?: TerrainBrush[];
    compressor?: GzipCompressor | null;
    decompressor?: GzipDecompressor | null;
  }) {
    this.adapter = options.adapter;
    this.mapId = options.mapId;
    this.layerId = options.layerId;
    this.width = options.width;
    this.height = options.height;
    this.palette = options.palette && options.palette.length > 0 ? options.palette : DEFAULT_TERRAIN_PALETTE;
    this.compressor = options.compressor ?? null;
    this.decompressor = options.decompressor ?? null;
    this.indices = new Uint8Array(options.width * options.height);
  }

  /** 已载入的瓦片数（用于界面提示） */
  get loadedTileCount(): number {
    return this.baselineTiles.size;
  }

  /** 当前脏瓦片数 */
  get dirtyCount(): number {
    return this.dirty.size;
  }

  /**
   * 全量载入栅格图层。
   * 瓦片不存在的部分保持为 0（透明）。
   * @returns 载入的瓦片数
   */
  async load(): Promise<number> {
    const cols = Math.ceil(this.width / TILE_SIZE);
    const rows = Math.ceil(this.height / TILE_SIZE);
    const coords: TileCoord[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        coords.push({ col, row });
      }
    }

    const tiles = await this.adapter.loadTiles(this.mapId, this.layerId, coords);
    let loaded = 0;
    for (const [index, coord] of coords.entries()) {
      const tile = tiles[index];
      // 缺失的瓦片 = 空瓦片：记录一份全零基线，这样「涂了又擦回」不会误判为有改动
      const slice = tile ? await this.decodeToIndices(tile, coord) : this.emptyTile(coord);
      if (!slice) {
        continue;
      }
      this.blitTile(coord, slice);
      this.baselineTiles.set(tileKey(coord.col, coord.row), slice);
      if (tile) {
        loaded += 1;
      }
    }
    this.dirty.clear();
    return loaded;
  }

  /** 生成某瓦片的全零切片（空瓦片基线） */
  private emptyTile(coord: TileCoord): Uint8Array {
    const { width, height } = this.tileSizeAt(coord);
    return new Uint8Array(width * height);
  }

  /**
   * 标记某个像素矩形覆盖到的瓦片为脏。
   * @param rect 世界像素矩形
   */
  markDirty(rect: PixelRect): void {
    const { minCol, maxCol, minRow, maxRow } = tileRangeOf(this.width, this.height, rect);
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        this.dirty.add(tileKey(col, row));
      }
    }
  }

  /** 把矩形外扩后整块标记为脏（撤销时用：差异区域可能超出原笔画矩形） */
  markDirtyAll(): void {
    const cols = Math.ceil(this.width / TILE_SIZE);
    const rows = Math.ceil(this.height / TILE_SIZE);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        this.dirty.add(tileKey(col, row));
      }
    }
  }

  /**
   * 取出待保存的瓦片（已编码为 cwt1）。
   *
   * 只提交**与服务器端已知内容不同**的瓦片（即与 baseline 不同），
   * 因此「涂一笔又擦回原样」不会产生无意义的上传。
   *
   * 注意：本方法**不改动 baseline**——baseline 只在保存成功后由
   * `commitBaseline()` 更新。否则「取瓦片 → 保存失败 → 重试」会误判为无变化而丢改动。
   *
   * @returns 待提交瓦片；没有实际变化时返回空数组
   */
  async takeDirtyTiles(): Promise<Tile[]> {
    const tiles: Tile[] = [];

    for (const key of this.dirty) {
      const coord = parseTileKey(key);
      const slice = this.extractTile(coord);
      const baseline = this.baselineTiles.get(key);
      if (baseline && sameBytes(baseline, slice)) {
        continue;
      }
      const { width, height } = this.tileSizeAt(coord);
      const data = await encodeTile({ indices: slice, width, height }, this.compressor);
      tiles.push({ coord, format: "cwt1", data });
    }

    return tiles;
  }

  /**
   * 保存成功后确认基线：把这些瓦片的当前内容记为「服务器端已知内容」，并清除脏标记。
   * @param coords 已成功保存的瓦片坐标
   */
  commitBaseline(coords: TileCoord[]): void {
    for (const coord of coords) {
      const key = tileKey(coord.col, coord.row);
      this.baselineTiles.set(key, this.extractTile(coord));
      this.dirty.delete(key);
    }
  }

  /**
   * 保存成功后清空指定键的脏标记（用于「无变化」的瓦片）。
   * @param keys 瓦片键
   */
  clearDirty(keys: string[]): void {
    for (const key of keys) {
      this.dirty.delete(key);
    }
  }

  /**
   * 把所有脏瓦片都确认为基线并清除。
   * 用于「脏瓦片的内容其实与服务器端一致」的情形（例如涂了又擦回），
   * 此时无需上传，但也不能一直留着脏标记。
   */
  clearDirtyAsBaseline(): void {
    const coords: TileCoord[] = [];
    for (const key of this.dirty) {
      coords.push(parseTileKey(key));
    }
    this.commitBaseline(coords);
  }

  /**
   * 保存失败时把瓦片重新标脏。
   * @param keys 需要重新标脏的键
   */
  remarkDirty(keys: string[]): void {
    for (const key of keys) {
      this.dirty.add(key);
    }
  }

  /**
   * 读取某瓦片的实际尺寸（边缘瓦片可能不足 256）。
   * @param coord 瓦片坐标
   * @returns 宽高
   */
  tileSizeAt(coord: TileCoord): { width: number; height: number } {
    return {
      width: Math.min(TILE_SIZE, this.width - coord.col * TILE_SIZE),
      height: Math.min(TILE_SIZE, this.height - coord.row * TILE_SIZE),
    };
  }

  /**
   * 把某个像素矩形的数据复制出来（用于历史记录）。
   * @param rect 矩形
   * @returns 行优先的索引副本
   */
  readRect(rect: PixelRect): Uint8Array {
    const out = new Uint8Array(rect.width * rect.height);
    for (let row = 0; row < rect.height; row += 1) {
      const sourceStart = (rect.y + row) * this.width + rect.x;
      out.set(this.indices.subarray(sourceStart, sourceStart + rect.width), row * rect.width);
    }
    return out;
  }

  /**
   * 把数据写回某个像素矩形（撤销 / 重做时用）。
   * @param rect 矩形
   * @param data 行优先的索引数据
   */
  writeRect(rect: PixelRect, data: Uint8Array): void {
    for (let row = 0; row < rect.height; row += 1) {
      const targetStart = (rect.y + row) * this.width + rect.x;
      this.indices.set(data.subarray(row * rect.width, (row + 1) * rect.width), targetStart);
    }
    this.markDirty(rect);
  }

  /**
   * 读取某像素的调色板下标（吸管用）。
   * @param x 世界像素 x
   * @param y 世界像素 y
   * @returns 调色板下标；越界返回 0
   */
  sampleAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return 0;
    }
    return this.indices[y * this.width + x] ?? 0;
  }

  /** 把瓦片切片写入全幅栅格 */
  private blitTile(coord: TileCoord, slice: Uint8Array): void {
    const { width, height } = this.tileSizeAt(coord);
    const originX = coord.col * TILE_SIZE;
    const originY = coord.row * TILE_SIZE;
    for (let row = 0; row < height; row += 1) {
      const targetStart = (originY + row) * this.width + originX;
      this.indices.set(slice.subarray(row * width, (row + 1) * width), targetStart);
    }
  }

  /** 从全幅栅格取出某瓦片切片 */
  private extractTile(coord: TileCoord): Uint8Array {
    const { width, height } = this.tileSizeAt(coord);
    const out = new Uint8Array(width * height);
    const originX = coord.col * TILE_SIZE;
    const originY = coord.row * TILE_SIZE;
    for (let row = 0; row < height; row += 1) {
      const sourceStart = (originY + row) * this.width + originX;
      out.set(this.indices.subarray(sourceStart, sourceStart + width), row * width);
    }
    return out;
  }

  /**
   * 解码瓦片字节为索引切片。
   * 适配器约定：交给插件的 `Tile.data` 一律是**未压缩的 cwt1**，
   * 压缩 / 解压由适配器实现层负责（换端时只改适配器）。
   * @param tile 瓦片
   * @param coord 坐标
   * @returns 索引切片；失败返回 null
   */
  private async decodeToIndices(tile: Tile, coord: TileCoord): Promise<Uint8Array | null> {
    try {
      const { width, height } = this.tileSizeAt(coord);
      const data = tile.data;
      const compression = data[8] ?? 0;
      if (compression === 0) {
        if (data.length < CWT1_HEADER_BYTES + width * height) {
          return null;
        }
        return new Uint8Array(data.subarray(CWT1_HEADER_BYTES, CWT1_HEADER_BYTES + width * height));
      }
      const decoded = await decodeTile(data, this.decompressor);
      // 尺寸可能比目标切片大（例如整瓦片 256×256），按目标尺寸裁剪
      if (decoded.width === width && decoded.height === height) {
        return new Uint8Array(decoded.indices);
      }
      return cropIndices(decoded.indices, decoded.width, width, height);
    } catch {
      return null;
    }
  }
}

/**
 * 计算像素矩形覆盖到的瓦片行列范围。
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @param rect 像素矩形
 * @returns 行列范围（已夹在网格内）
 */
export function tileRangeOf(
  boardWidth: number,
  boardHeight: number,
  rect: PixelRect,
): { minCol: number; maxCol: number; minRow: number; maxRow: number } {
  const cols = Math.ceil(boardWidth / TILE_SIZE);
  const rows = Math.ceil(boardHeight / TILE_SIZE);
  return {
    minCol: Math.max(0, Math.floor(rect.x / TILE_SIZE)),
    maxCol: Math.min(cols - 1, Math.floor((rect.x + rect.width - 1) / TILE_SIZE)),
    minRow: Math.max(0, Math.floor(rect.y / TILE_SIZE)),
    maxRow: Math.min(rows - 1, Math.floor((rect.y + rect.height - 1) / TILE_SIZE)),
  };
}

/**
 * 比较两段索引数据是否完全一致。
 * @param a 数据 A
 * @param b 数据 B
 * @returns 一致返回 true
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * 从大瓦片里裁出目标尺寸的左上角区域（边缘瓦片会用到）。
 * @param source 源索引
 * @param sourceWidth 源宽
 * @param width 目标宽
 * @param height 目标高
 * @returns 裁剪后的索引
 */
function cropIndices(source: Uint8Array, sourceWidth: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = row * sourceWidth;
    out.set(source.subarray(sourceStart, sourceStart + width), row * width);
  }
  return out;
}
