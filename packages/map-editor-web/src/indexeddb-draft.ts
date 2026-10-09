/**
 * 浏览器侧的草稿存储：把「尚未保存成功的内容」暂存到 IndexedDB。
 *
 * 为什么需要它：自动保存是「停止绘制 3 秒后触发」，但用户可能刚画完就关掉页面、
 * 断网导致保存失败、或误刷新。草稿让这些内容在本地留痕，下次打开时提示恢复。
 *
 * 存储策略：
 * - 只存**变化过的瓦片**（cwt1 字节，已压缩），而不是整幅栅格 —— 2048 白板的整幅
 *   是 2MB，变化瓦片通常只有几个到几十 KB
 * - 存 `Uint8Array` 而不是 base64 字符串：IndexedDB 支持结构化克隆，直接存二进制
 *   更省空间也更快
 * - 草稿与地图 id 一一对应，同一张图只留最新一份
 */
import { decodeTile, encodeTile, createNativeGzip, type DraftStore, type EditorDraft, type Tile } from "@worldmap/core";

/** IndexedDB 数据库名与对象仓库名 */
const DB_NAME = "worldmap-editor";
const STORE_NAME = "drafts";
const DB_VERSION = 1;

/** 落库的草稿记录 */
interface DraftRecord {
  mapId: string;
  savedAt: number;
  /** 变化瓦片：坐标 + cwt1 字节 */
  tiles: { col: number; row: number; data: ArrayBuffer }[];
  /** 栅格图层的 id（恢复时要写回同一层） */
  layerId: string;
  /** 白板尺寸（校验草稿是否与当前白板匹配） */
  width: number;
  height: number;
}

/**
 * 打开（并首次创建）IndexedDB 数据库。
 * @returns 数据库句柄
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "mapId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("无法打开本地草稿库"));
  });
}

/**
 * 在事务中执行一次读写。
 * @param mode 事务模式
 * @param run 使用对象仓库的回调
 * @returns 回调结果
 */
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("本地草稿读写失败"));
      transaction.onabort = () => reject(new Error("本地草稿事务被中断"));
    });
  } finally {
    db.close();
  }
}

/**
 * 创建 IndexedDB 草稿存储。
 *
 * 运行环境不支持 IndexedDB（如某些隐私模式）时 `isAvailable()` 返回 false，
 * 编辑器会自动退化为「不做本地草稿」，不影响其他功能。
 *
 * @returns DraftStore 实现（额外暴露 `saveTiles` / `loadTiles` 供编辑器直接用瓦片粒度操作）
 */
export function createIndexedDbDraftStore(): IndexedDbDraftStore {
  return new IndexedDbDraftStore();
}

/** 把瓦片单独存取的草稿实现（编辑器用它做增量暂存） */
export class IndexedDbDraftStore implements DraftStore {
  private readonly gzip = createNativeGzip();

  /** 当前环境是否可用 IndexedDB */
  isAvailable(): boolean {
    return typeof indexedDB !== "undefined";
  }

  /**
   * 写入（覆盖）某地图的草稿瓦片。
   * @param input 地图 id、图层 id、白板尺寸与变化瓦片
   */
  async saveTiles(input: {
    mapId: string;
    layerId: string;
    width: number;
    height: number;
    tiles: Tile[];
  }): Promise<void> {
    if (!this.isAvailable() || input.tiles.length === 0) {
      return;
    }
    const record: DraftRecord = {
      mapId: input.mapId,
      savedAt: Date.now(),
      layerId: input.layerId,
      width: input.width,
      height: input.height,
      tiles: input.tiles.map((tile) => ({
        col: tile.coord.col,
        row: tile.coord.row,
        // 存 ArrayBuffer 副本：结构化克隆对视图的切片语义不直观，显式复制更安全
        data: toArrayBuffer(tile.data),
      })),
    };
    await withStore("readwrite", (store) => store.put(record) as IDBRequest<IDBValidKey>);
  }

  /**
   * 读取某地图的草稿瓦片。
   * @param mapId 地图 id
   * @returns 草稿（含保存时间与瓦片）；没有草稿或尺寸不匹配时返回 null
   */
  async loadTiles(mapId: string, width: number, height: number): Promise<{ savedAt: number; tiles: Tile[] } | null> {
    if (!this.isAvailable()) {
      return null;
    }
    const record = await withStore<DraftRecord | undefined>(
      "readonly",
      (store) => store.get(mapId) as IDBRequest<DraftRecord | undefined>,
    );
    if (!record) {
      return null;
    }
    // 白板尺寸变了（改过分辨率）就丢弃草稿：坐标语义已不同
    if (record.width !== width || record.height !== height) {
      await this.clear(mapId);
      return null;
    }
    const tiles: Tile[] = record.tiles.map((item) => ({
      coord: { col: item.col, row: item.row },
      format: "cwt1",
      data: new Uint8Array(item.data),
    }));
    return { savedAt: record.savedAt, tiles };
  }

  /**
   * 按统一契约保存草稿（瓦片已编码）。
   * @param draft 草稿
   */
  async save(draft: EditorDraft): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }
    const existing = await withStore<DraftRecord | undefined>(
      "readonly",
      (store) => store.get(draft.mapId) as IDBRequest<DraftRecord | undefined>,
    );
    await this.saveTiles({
      mapId: draft.mapId,
      layerId: existing?.layerId ?? "",
      width: existing?.width ?? 0,
      height: existing?.height ?? 0,
      tiles: draft.tiles,
    });
  }

  /**
   * 读取草稿（统一契约）。
   * @param mapId 地图 id
   * @returns 草稿；没有则返回 null
   */
  async load(mapId: string): Promise<EditorDraft | null> {
    const record = await withStore<DraftRecord | undefined>(
      "readonly",
      (store) => store.get(mapId) as IDBRequest<DraftRecord | undefined>,
    );
    if (!record) {
      return null;
    }
    return {
      mapId,
      savedAt: record.savedAt,
      tiles: record.tiles.map((item) => ({
        coord: { col: item.col, row: item.row },
        format: "cwt1",
        data: new Uint8Array(item.data),
      })),
    };
  }

  /**
   * 清除某地图的草稿。
   * @param mapId 地图 id
   */
  async clear(mapId: string): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }
    await withStore("readwrite", (store) => store.delete(mapId) as IDBRequest<undefined>);
  }

  /**
   * 把草稿瓦片解码成索引数据，供编辑器写回全幅栅格。
   * @param tile 草稿瓦片
   * @returns 索引数据；解码失败返回 null
   */
  async decodeDraftTile(tile: Tile): Promise<Uint8Array | null> {
    try {
      const compression = tile.data[8] ?? 0;
      if (compression === 0) {
        return new Uint8Array(tile.data.subarray(9));
      }
      const decoded = await decodeTile(tile.data, this.gzip?.decompressor);
      return new Uint8Array(decoded.indices);
    } catch {
      return null;
    }
  }

  /**
   * 把索引数据编码成 cwt1（草稿里的瓦片统一按压缩存）。
   * @param indices 索引数据
   * @param width 宽
   * @param height 高
   * @returns cwt1 字节
   */
  async encodeDraftTile(indices: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    return encodeTile({ indices, width, height }, this.gzip?.compressor);
  }
}

/**
 * 复制 Uint8Array 到独立的 ArrayBuffer（便于结构化克隆）。
 * @param bytes 源字节
 * @returns 独立缓冲
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}
