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

  /**
   * 改白板尺寸（重采样后的瓦片，可分批提交）。
   *
   * 分工：**重采样由插件完成**（最近邻），宿主只负责把瓦片按批写入后端。
   * `first` 标记是否为第一批——后端通常在首批时清空旧瓦片并更新白板尺寸。
   *
   * @param input 地图 id、新宽度、版本号、是否首批、以及一批瓦片（含所属图层）
   * @returns 服务端接受后的新版本号（若无返回则回传传入值）
   */
  resizeBoard?(input: {
    mapId: string;
    width: number;
    revision: number;
    first: boolean;
    tiles: { layerId: string; tiles: Tile[] }[];
  }): Promise<{ revision: number } | void>;
}

/** 保存状态：与主站条目编辑器的反馈文案保持一致 */
export type SaveState = "idle" | "saving" | "saved" | "offline" | "error";

/**
 * 手写地名所用字体的加载状态。
 *
 * 之所以要有 `fallback`：字体是**可选的观感增强**，
 * 加载失败（地址失效、体积过大超时、浏览器不支持 woff2）必须能降级到系统楷体，
 * 而不是让界面一直停在「加载中」。
 */
export type HandwritingFontState = "idle" | "loading" | "ready" | "fallback";

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
  /**
   * 手写体字体栈（地名用手写体时使用，见 `MapEditorProps.labelsHandwriting`）。
   *
   * 默认值以**系统楷体**打头（`Kaiti SC` / `STKaiti` / `楷体` / `KaiTi`）：
   * 完整中文字体文件体积太大，默认只走系统字体，零下载也能有手写感；
   * 想用统一的跨端观感时，宿主再提供 `handwritingFontUrl` 并把它加到这一串最前面。
   */
  fontHand: string;
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

/**
 * 编辑器的界面偏好（网格密度、渲染风格、缩放范围等）。
 *
 * 放在宿主侧保存而不是插件里：插件本体不允许碰 localStorage（边界规则第 3 条），
 * 各端怎么存（Web 用 localStorage、桌面用配置文件）由宿主决定。
 */
export interface MapEditorViewSettings {
  /** 经纬网档位（0 = 自动按缩放选） */
  gridIntervalDeg?: number;
  /** 渲染风格：简约色块 / 手绘图案 */
  renderStyle?: "flat" | "handdrawn";
  /** 缩放范围（缩放倍率） */
  zoomMin?: number;
  zoomMax?: number;
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
  /**
   * 纸张素材地址（可选）：手绘图案模式下的纸张底色贴图，由宿主的资源管线提供。
   *
   * 为什么用 URL 而不是让插件自己去找文件：插件本体不允许发网络请求（边界规则第 3 条），
   * 素材应被宿主打包进产物、或由 CDN 托管后把地址传进来。
   * 不传时插件用内置的程序化暗纸；地址失效时自动退回内置版本（不会白屏）。
   */
  paperTextureUrl?: string;
  /**
   * 纸张铺法（默认 `tile` 平铺）：
   * - `tile` 适合**图案型**素材（花纹、织物、可无缝重复的纹理）
   * - `stretch` 适合**照片型**素材（一张完整的羊皮纸 / 老纸照片）：整幅只铺一次，没有重复感
   */
  paperFill?: "tile" | "stretch";
  /** 纸张平铺单元边长（默认 512，仅 `tile` 用）：越大重复感越弱、显存占用越高 */
  paperTextureTileSize?: number;
  /**
   * 是否叠一层**旧纸纹理**（默认开启；只影响手绘模式的纸张，与数据层无关）。
   *
   * 由插件**程序化生成**（固定种子）：细颗粒噪点 + 几块极淡的渍斑 + 一两道折痕，
   * 用来给「一张被放大的纸照片」补上层次。素材照片本身分辨率有限，
   * 拉伸铺满大号白板后细节会偏平，靠这一层把「旧」的感觉找回来。
   * 关掉它就回到「只有纸张照片」的样子。
   */
  paperGrain?: boolean;
  /**
   * 旧纸纹理强度（0~1，默认 0.35，很轻）。
   *
   * 0 与 `paperGrain: false` 等效；调高会更旧但也会更「脏」，
   * 建议超过 0.6 前先在目标纸张素材上看一眼效果。
   */
  paperGrainStrength?: number;
  /**
   * 地名是否用手写体（默认关闭）。
   *
   * 开启后，画布上的地名标注、测量读数、比例尺与标记列表都改用楷体 / 手写字体栈
   * （见 `MapEditorTheme.fontHand`）；关闭则保持无衬线体。
   * 与纸张 / 旧纸纹理一样，这只影响渲染，不写入任何数据。
   */
  labelsHandwriting?: boolean;
  /**
   * 装饰符号的画风（默认 `antique` 古地图）。
   *
   * - `antique`：木刻线条素材（随插件分发的 Kenney Cartography Pack，CC0）
   * - `modern`：程序化绘制的简洁现代手绘
   *
   * ⚠️ **只影响观感，不碰数据**：数据层永远只有 1 字节/格的调色板下标，
   * 符号是渲染时的产物。因此切换画风既不写瓦片、也不产生脏数据，
   * 用户的地图内容与保存 / 导出都不受影响（工具栏上可随时来回切）。
   * 默认取 `antique`：主站配的是羊皮纸素材，木刻符号更配。
   */
  symbolStyle?: "antique" | "modern";
  /**
   * 手写字体文件地址（可选，由宿主提供）。
   *
   * 为什么必须由宿主传：插件本体不做网络请求（边界规则第 3 条），
   * 而且完整中文字体动辄数 MB，**不该默认打包**。
   * 宿主把它托管在自己的静态资源 / CDN 上，用户打开「手写地名」后再把地址交进来，
   * 插件用 `FontFace` 按需加载（详见 `src/handwriting-font.ts` 的说明）。
   *
   * 不传、加载失败或超时（默认 8 秒）时静默降级到系统楷体栈，界面不阻塞也不报错。
   */
  handwritingFontUrl?: string;
  /** 加载失败时的超时时间（毫秒，默认 8000）：到点即降级，避免"卡在加载中" */
  handwritingFontTimeoutMs?: number;
  /** 手写字体加载状态变化时通知宿主（宿主可据此提示或重试） */
  onHandwritingFontStateChange?: (state: HandwritingFontState) => void;
  locale?: "zh-CN" | "en";
  features?: MapEditorFeatures;
  /**
   * 界面偏好：宿主注入初值，并在用户改动时收到通知以便自行保存。
   *
   * 插件不落盘（不碰 localStorage），只在自己的生命周期里用这份状态。
   */
  viewSettings?: {
    initial?: MapEditorViewSettings;
    onChange?: (settings: MapEditorViewSettings) => void;
  };
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
