/**
 * 插件与外界之间的数据契约。
 * 详见 docs/地图编辑器方案.md §15.3。
 *
 * 本文件只依赖 @worldmap/core（纯类型），不依赖 React、不依赖 DOM。
 */
import type {
  DraftStore,
  FeatureQuery,
  MapFeature,
  MapLayer,
  MapMeta,
  MapScaleStats,
  Tile,
  TileCoord,
} from "@worldmap/core";

/** 瓦片保存结果 */
export interface SaveTilesResult {
  /** 保存后的新版本号 */
  revision: number;
  /** 版本冲突（宿主侧 revision 比提交的更新） */
  conflict?: boolean;
}

/** 图层保存入参 */
export interface SaveLayersInput {
  mapId: string;
  layers: MapLayer[];
}

/**
 * 宿主适配器：插件与外界的所有数据进出都走这里。
 *
 * 设计取舍：`adapter` 是**必需**参数而不是可选 —— 「插件自带后端」是伪需求，
 * 插件的价值恰恰在于不绑定后端：宿主给什么存储，它就用什么存储。
 *
 * 能力递进：只实现前三个方法即可用「2D 绘制 + 图层 + 撤销 + 比例尺」，
 * 逐步补齐才解锁矢量对象、草稿恢复、统计持久化 —— 缺接口只少能力，不应启动失败。
 */
export interface MapHostAdapter {
  /** 读取地图元信息（白板规格、图层、revision、调色板） */
  loadMeta(mapId: string): Promise<MapMeta>;

  /** 读取指定瓦片；不存在的瓦片返回 null（缺失即视为空瓦片） */
  loadTiles(mapId: string, layerId: string, coords: TileCoord[]): Promise<(Tile | null)[]>;

  /** 增量写入变化瓦片；revision 不匹配时应返回 conflict 而不是静默覆盖 */
  saveTiles(input: {
    mapId: string;
    layerId: string;
    tiles: Tile[];
    revision: number;
  }): Promise<SaveTilesResult>;

  // —— 以下均为可选：宿主不实现则对应能力降级 ——

  /** 按视口读取矢量对象（矢量图层需要） */
  loadFeatures?(mapId: string, query: FeatureQuery): Promise<MapFeature[]>;

  /** 矢量对象写操作 */
  saveFeatures?(input: { mapId: string; upsert: MapFeature[]; removeIds: string[] }): Promise<void>;

  /** 图层增删改（含排序） */
  saveLayers?(input: SaveLayersInput): Promise<void>;

  /** 把尺度统计交给宿主持久化（不实现则仅客户端统计） */
  saveStats?(mapId: string, stats: MapScaleStats): Promise<void>;

  /** 本地草稿；不实现则退化为仅内存，离开页面即丢 */
  drafts?: DraftStore;
}
