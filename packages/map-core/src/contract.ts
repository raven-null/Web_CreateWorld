/**
 * 插件与宿主之间的契约（**公共类型中心**）。
 *
 * 放在零依赖的内核包里，理由有两条：
 * 1. 宿主适配器实现（如 `@worldmap/editor-web`）与插件本体都能从这里取类型，
 *    不必互相依赖 —— 依赖始终指向内核，方向单一
 * 2. 类型是「跨端与跨宿主共用的语言」，与投影、比例尺同属领域层
 *
 * 实现约定（由 scripts/check-boundaries.mjs 强制）：
 * - 契约只描述数据进出，**不出现任何宿主业务概念**（主站放条目 id 时用中性的 `linkRef`）
 * - 宿主不必实现全部方法：缺接口只少能力，不应启动失败
 */
import type { MapScaleStats } from "./stats";
import type { DraftStore, FeatureQuery, MapFeature, MapLayer, MapMeta, Tile, TileCoord } from "./types";/** 瓦片保存结果 */
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
 * 宿主侧标记行（最小字段集）。
 *
 * 刻意不叫 `entryId` / `entryTitle`：插件不认识「条目」这类业务概念，
 * 主站把自己的条目 id 放进 `linkRef` 即可，插件只把它当不透明字符串透传。
 */
export interface HostMarker {
  id: string;
  /** 平面归一化坐标（0~1，原点左上） */
  u: number;
  v: number;
  label: string;
  /** 宿主侧关联标识（可空） */
  linkRef?: string | null;
  /** 关联对象的显示名（可空） */
  linkLabel?: string | null;
}

/**
 * 宿主适配器：插件与外界的所有数据进出都走这里。
 *
 * `adapter` 是**必需**参数而不是可选 —— 「插件自带后端」是伪需求，
 * 插件的价值恰恰在于不绑定后端：宿主给什么存储，它就用什么存储。
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

  /** 读取标记列表（锚点对象）。宿主不实现则画布不显示标记 */
  loadMarkers?(mapId: string): Promise<HostMarker[]>;

  /** 写回标记位置（归一化坐标） */
  saveMarkerPosition?(input: { mapId: string; markerId: string; u: number; v: number }): Promise<void>;

  /** 新增标记 */
  createMarker?(input: {
    mapId: string;
    u: number;
    v: number;
    label: string;
    linkRef: string | null;
  }): Promise<{ id: string }>;

  /** 删除标记 */
  deleteMarker?(input: { mapId: string; markerId: string }): Promise<void>;
}

/** 保存状态：与主站条目编辑器的反馈文案保持一致 */
export type SaveState = "idle" | "saving" | "saved" | "offline" | "error";

/**
 * 主题 token（视觉契约）。
 *
 * 插件**不假设宿主的 CSS 变量名**：用自己命名空间的 token，
 * 宿主可通过 `theme` 覆盖，不传则回退内置默认值。
 */
export interface MapEditorTheme {
  background: string;
  panel: string;
  border: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  radius: string;
  fontSans: string;
  fontSerif: string;
  /** 3D 视图专用（§14.3.5），不传则用内置值 */
  globeSkyColor?: string;
  globeAtmosphereColor?: string;
  globeNightColor?: string;
}

/** 功能开关：不传则全开 */
export interface MapEditorFeatures {
  layers?: boolean;
  scale?: boolean;
  measure?: boolean;
  globe3d?: boolean;
  export?: boolean;
  /** 3D 美术效果（§14.3）：桌面默认全开、移动端默认仅关大气辉光 */
  globeEffects?: {
    atmosphere?: boolean;
    stars?: boolean;
    dayNight?: boolean;
  };
}

/** 组件 props */
export interface MapEditorProps {
  mapId: string;
  /** 宿主适配器（必需）：插件不假设后端 */
  adapter: MapHostAdapter;
  /** 只读模式（公开世界、分享页、只读嵌入） */
  readOnly?: boolean;
  /**
   * 本地草稿（可选）：由宿主提供实现（Web 用 IndexedDB，桌面 / 手机用 SQLite）。
   *
   * 之所以放在 props 而不是适配器里：草稿是「本地暂存」这件事的抽象，
   * 与「访问后端」不是一回事 —— 换后端（HTTP → SQLite）时草稿实现可以不变。
   */
  drafts?: DraftStore;
  /** 初始视图：经纬度中心 + 缩放 */
  initialView?: { lon: number; lat: number; zoom: number };
  theme?: Partial<MapEditorTheme>;
  locale?: "zh-CN" | "en";
  features?: MapEditorFeatures;
  onSaveStateChange?: (state: SaveState) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onExport?: (blob: Blob, suggestedName: string) => void | Promise<void>;
  /** 点击标记：由宿主决定跳转到哪里（插件只上报中性标识） */
  onMarkerClick?: (markerId: string, linkRef?: string) => void;
  onError?: (error: Error) => void;
  onStatsChange?: (stats: MapScaleStats) => void;
  /** 检测到比服务端更新的本地草稿时通知宿主（宿主可自行提示，不实现则由插件内提示） */
  onDraftAvailable?: (savedAt: number) => void;
}

/** 命令式 API：通过 ref 调用 */
export interface MapEditorHandle {
  save(): Promise<void>;
  exportImage(options?: {
    scale?: number;
    includeScaleBar?: boolean;
    includeGraticule?: boolean;
    /** 3D 截图时是否带昼夜明暗（false = 均匀光照） */
    flatLighting?: boolean;
  }): Promise<Blob>;
  /** 自包含快照（§15.7），可换后端 / 换项目迁移 */
  getSnapshot(): Promise<unknown>;
  loadSnapshot(snapshot: unknown): Promise<void>;
  fitToWorld(): void;
  setLayerVisibility(layerId: string, visible: boolean): void;
  /** 切到 2D / 3D 视图 */
  setViewMode(mode: "2d" | "3d"): void;
}
