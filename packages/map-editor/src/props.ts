/**
 * 插件对外 props 与主题契约。
 * 详见 docs/地图编辑器方案.md §15.3（对外 API）与 §15.4（主题与样式隔离）。
 */
import type { MapScaleStats } from "@worldmap/core";
import type { MapHostAdapter } from "./adapter";

/**
 * 主题 token：插件**不假设宿主的 CSS 变量名**，用自己命名空间的 token；
 * 宿主可通过 theme 覆盖，不传则回退内置默认（与主站深色主题取同值）。
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

/** 保存状态：与主站条目编辑器的反馈文案保持一致 */
export type SaveState = "idle" | "saving" | "saved" | "offline" | "error";

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
  /** 初始视图：经纬度中心 + 缩放 */
  initialView?: { lon: number; lat: number; zoom: number };
  theme?: MapEditorTheme;
  locale?: "zh-CN" | "en";
  features?: MapEditorFeatures;
  onSaveStateChange?: (state: SaveState) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onExport?: (blob: Blob, suggestedName: string) => void | Promise<void>;
  /** 点击标记：由宿主决定跳转到哪里（插件只上报中性标识，不认识业务概念） */
  onMarkerClick?: (markerId: string, linkRef?: string) => void;
  onError?: (error: Error) => void;
  onStatsChange?: (stats: MapScaleStats) => void;
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
