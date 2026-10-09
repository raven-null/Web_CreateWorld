/**
 * 尺度预警（方案 §7.7 / §7.7.1）。
 *
 * 原则：**常识是默认值，不是法律**。用户的设定超出地球常识时，
 * 有权关掉这套常识、按自己的想法来 —— 因此阈值全部集中在配置里，
 * 规则函数不得写死数字。
 *
 * 只静音「常识判据」，不关「客观读数」：
 * 实距、面积、变形倍率、比例尺条始终显示，否则用户会失去判断依据。
 */
import { boardSurfaceAreaKm2 } from "./geo-area";
import type { BoardSpec } from "./types";

/** 预警级别：info 仅陈述，warn 明显偏离常识 */
export type ScaleHintLevel = "info" | "warn";

/** 尺度预警配置（存在地图级，见方案 §7.7.1） */
export interface ScaleHintConfig {
  /** 三档预设：按地球常识 / 宽松 / 关闭 */
  mode: "earth" | "loose" | "off";
  /** 单块陆地占天体表面的百分比阈值（默认 15） */
  landmassPercent?: number;
  /** 全球陆地占比阈值（默认 45） */
  globalLandPercent?: number;
  /** 单一国家面积阈值（km²，默认 3000 万） */
  countryAreaKm2?: number;
  /** 白板精度阈值（km/px，默认 20） */
  precisionKmPerPx?: number;
  /** 变形倍率阈值（默认 2） */
  deformFactor?: number;
  /** 每条规则的静音截止时间（规则 id → 时间戳，按地图记） */
  silentUntil?: Record<string, number>;
}

/** 参与判定的指标（由统计与视图状态提供） */
export interface ScaleMetrics {
  /** 当前白板规格（需要 radiusKm） */
  board: BoardSpec;
  /** 单块最大陆地面积（km²） */
  largestLandmassKm2?: number;
  /** 全部陆地面积占比（%，相对天体表面） */
  landPercent?: number;
  /** 当前政治图层中最大国家面积（km²） */
  largestCountryKm2?: number;
  /** 当前赤道每像素实距（km/px） */
  kmPerPixel?: number;
  /** 当前光标纬度处的变形倍率 */
  deform?: number;
}

/** 一条待展示的提示 */
export interface ScaleHint {
  id: string;
  level: ScaleHintLevel;
  message: string;
}

/** 默认阈值（按地球常识） */
export const EARTH_COMMONSENSE: Required<Omit<ScaleHintConfig, "mode" | "silentUntil">> = {
  landmassPercent: 15,
  globalLandPercent: 45,
  countryAreaKm2: 3e7,
  precisionKmPerPx: 20,
  deformFactor: 2,
};

/**
 * 按预设模式得到生效的阈值。
 * @param config 用户配置
 * @param now 当前时间戳（用于判断静音是否过期）
 * @returns 生效阈值；mode 为 off 时返回 null
 */
export function resolveThresholds(
  config: ScaleHintConfig,
  now = Date.now(),
): Required<Omit<ScaleHintConfig, "mode" | "silentUntil">> | null {
  if (config.mode === "off") {
    return null;
  }
  const base = { ...EARTH_COMMONSENSE };
  if (config.mode === "loose") {
    // 宽松模式把阈值放大一倍，只在极端离谱时提醒
    base.landmassPercent *= 2;
    base.globalLandPercent = Math.min(95, base.globalLandPercent * 2 - 100 + 95);
    base.countryAreaKm2 *= 2;
    base.precisionKmPerPx *= 2;
    base.deformFactor *= 2;
  }
  return {
    landmassPercent: config.landmassPercent ?? base.landmassPercent,
    globalLandPercent: config.globalLandPercent ?? base.globalLandPercent,
    countryAreaKm2: config.countryAreaKm2 ?? base.countryAreaKm2,
    precisionKmPerPx: config.precisionKmPerPx ?? base.precisionKmPerPx,
    deformFactor: config.deformFactor ?? base.deformFactor,
  };
}

/**
 * 判断某条规则是否处于静音期。
 * @param config 配置
 * @param ruleId 规则 id
 * @param now 当前时间戳
 * @returns 静音中返回 true
 */
function isSilenced(config: ScaleHintConfig, ruleId: string, now: number): boolean {
  const until = config.silentUntil?.[ruleId];
  return typeof until === "number" && until > now;
}

/**
 * 评估全部尺度规则，返回应展示的提示列表。
 * @param metrics 指标
 * @param config 配置
 * @param now 当前时间戳
 * @returns 提示列表（可能为空）
 */
export function evaluateScaleHints(
  metrics: ScaleMetrics,
  config: ScaleHintConfig,
  now = Date.now(),
): ScaleHint[] {
  const thresholds = resolveThresholds(config, now);
  if (!thresholds) {
    return [];
  }
  const hints: ScaleHint[] = [];
  const surface = boardSurfaceAreaKm2(metrics.board);

  /** 追加前统一检查静音 */
  const push = (id: string, level: ScaleHintLevel, message: string): void => {
    if (!isSilenced(config, id, now)) {
      hints.push({ id, level, message });
    }
  };

  if (metrics.largestLandmassKm2 !== undefined && surface > 0) {
    const percent = (metrics.largestLandmassKm2 / surface) * 100;
    if (percent > thresholds.landmassPercent) {
      const level: ScaleHintLevel = percent > thresholds.landmassPercent * 1.7 ? "warn" : "info";
      push(
        "landmass",
        level,
        `这块陆地占全球 ${percent.toFixed(1)}%，比亚洲（4458 万 km²）还大 —— 确定不是把海涂成了陆地？`,
      );
    }
  }

  if (metrics.landPercent !== undefined && metrics.landPercent > thresholds.globalLandPercent) {
    push(
      "global-land",
      "info",
      `陆地占全球 ${metrics.landPercent.toFixed(1)}%，地球只有 29% —— 如果是海洋世界需要调整`,
    );
  }

  if (
    metrics.largestCountryKm2 !== undefined &&
    metrics.largestCountryKm2 > thresholds.countryAreaKm2
  ) {
    push(
      "country",
      "info",
      `该国面积约 ${(metrics.largestCountryKm2 / 1e4).toFixed(0)} 万 km²，超过俄罗斯（1710 万 km²）`,
    );
  }

  if (metrics.kmPerPixel !== undefined && metrics.kmPerPixel > thresholds.precisionKmPerPx) {
    push(
      "precision",
      "info",
      `当前每像素约 ${metrics.kmPerPixel.toFixed(1)} km，白板精度较低 —— 建议提高白板分辨率或增大天体半径`,
    );
  }

  if (metrics.deform !== undefined && metrics.deform > thresholds.deformFactor) {
    push(
      "deform",
      "info",
      `此处高纬变形 ×${metrics.deform.toFixed(1)}，尺寸不宜直接目测`,
    );
  }

  return hints;
}

/**
 * 生成一条规则的静音截止时间（默认 30 天）。
 * @param config 现有配置
 * @param ruleId 规则 id
 * @param days 静音天数
 * @param now 当前时间戳
 * @returns 新的配置对象
 */
export function silenceRule(
  config: ScaleHintConfig,
  ruleId: string,
  days = 30,
  now = Date.now(),
): ScaleHintConfig {
  return {
    ...config,
    silentUntil: {
      ...config.silentUntil,
      [ruleId]: now + days * 24 * 60 * 60 * 1000,
    },
  };
}

/** 默认配置：按地球常识 */
export const DEFAULT_SCALE_HINT_CONFIG: ScaleHintConfig = { mode: "earth" };
