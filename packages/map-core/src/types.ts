/**
 * 地图编辑器的核心数据类型。
 *
 * 设计要点（详见 docs/地图编辑器方案.md）：
 * 1. **经纬度是唯一坐标真源**，平面像素与球面坐标都由它派生 —— 2D 与 3D 共用一份数据
 * 2. 白板长宽比恒为 2:1（经度 360° : 纬度 180°），这是「平面白板 = 完整球面贴图」的前提
 * 3. 地形用「调色板索引栅格」，专题图层用矢量对象
 */

/** 地图类型：图片底图 / 球面白板 */
export type MapKind = "image" | "canvas";

/** 投影方式（首期只有等距圆柱） */
export type ProjectionKind = "equirect";

/**
 * 地理坐标（唯一真源）。
 * lon ∈ [-180, 180]，lat ∈ [-90, 90]，单位为度。
 */
export interface GeoPoint {
  lon: number;
  lat: number;
}

/** 平面归一化坐标（0~1，原点左上）——与数据库里 markers.x / y 的语义一致 */
export interface UvPoint {
  u: number;
  v: number;
}

/** 白板规格 */
export interface BoardSpec {
  /** 宽度：用户自由输入 512~16384，规整到 128 的倍数 */
  width: number;
  /** 高度：恒等于 width / 2 */
  height: number;
  projection: ProjectionKind;
  /** 天体半径（km），所有实距换算的唯一参数；默认地球 6371 */
  radiusKm: number;
}

/** 图层类型预设（开放集合，用户可自建 custom 图层） */
export type LayerType =
  | "terrain" // 地形：栅格笔刷
  | "political" // 政治：国界、势力范围
  | "military" // 军事：战线、进军箭头、据点
  | "religion" // 宗教：信仰分布
  | "ethnic" // 民族：族群分布
  | "labels" // 注记：地名（固定最上层）
  | "custom"; // 用户自定义

/** 图层的存储形态：栅格涂抹 / 矢量对象 */
export type LayerStorage = "raster" | "vector";

/** 图层定义 */
export interface MapLayer {
  id: string;
  name: string;
  type: LayerType;
  storage: LayerStorage;
  visible: boolean;
  opacity: number;
  /** 渲染顺序，越大越在上层 */
  zIndex: number;
  /** 图例项（名称 + 颜色） */
  legend: { label: string; color: string }[];
}

/** 地形笔刷（调色板项）：索引 0 保留为透明 */
export interface TerrainBrush {
  /** 调色板下标，0 = 透明 */
  index: number;
  /** 稳定标识，如 "ocean" / "grass" */
  key: string;
  /** 界面显示名 */
  name: string;
  /** 颜色（地图内容自身的颜色，与 UI token 无关） */
  color: string;
}

/** 方格瓦片坐标（列环绕、行不环绕） */
export interface TileCoord {
  col: number;
  row: number;
}

/** 瓦片数据：索引栅格 + 编码格式 */
export interface Tile {
  coord: TileCoord;
  /** 编码格式标识，当前只有 "cwt1" */
  format: string;
  /** 已编码的字节（cwt1：含压缩标识位） */
  data: Uint8Array;
}

/** 矢量对象类型 */
export type FeatureKind = "area" | "border" | "route" | "arrow" | "symbol" | "text";

/** 矢量对象（存经纬度，与白板分辨率无关） */
export interface MapFeature {
  id: string;
  layerId: string;
  kind: FeatureKind;
  /** 几何点列（经纬度） */
  points: GeoPoint[];
  /** 样式，结构由 kind 决定 */
  style?: Record<string, unknown>;
  label: string;
  /**
   * 关联标识：由宿主解释其含义（本插件只当作不透明字符串，
   * 主站会放进条目 id，其他宿主可以放任何东西）。
   */
  linkRef?: string | null;
  /** 重要度 1~5：比例尺显示规则用，值越大在小比例下越优先保留 */
  importance: number;
  /** 是否无视显示规则始终显示 */
  alwaysVisible: boolean;
  zIndex: number;
}

/** 视口查询：按图层 + 经纬度包围盒拉取对象 */
export interface FeatureQuery {
  layerId: string;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** 地图元信息（宿主适配器返回） */
export interface MapMeta {
  id: string;
  kind: MapKind;
  board: BoardSpec;
  /** 版本号：每次保存 +1，用于冲突检测 */
  revision: number;
  /** 地形调色板 */
  palette: TerrainBrush[];
  layers: MapLayer[];
  /** 只读权限标记（插件据此禁用编辑入口） */
  canEdit: boolean;
}

/** 草稿（本地暂存，不落宿主后端） */
export interface EditorDraft {
  mapId: string;
  /** 保存时间戳 */
  savedAt: number;
  /** 变更瓦片的快照 */
  tiles: Tile[];
}

/** 草稿存取（宿主可选实现；不实现则退化为仅内存） */
export interface DraftStore {
  save(draft: EditorDraft): Promise<void>;
  load(mapId: string): Promise<EditorDraft | null>;
  clear(mapId: string): Promise<void>;
}
