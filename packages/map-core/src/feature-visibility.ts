/**
 * 比例尺相关的显示规则（方案 §10.3）。
 *
 * 核心决策：**判据用「对象在屏幕上的像素尺寸」，不用 k₀（每像素实距）**。
 * 理由：用户不必换算 km/px ——「符号边长 ≥ 6 屏幕像素才显示」所见即所得，
 * 且与白板分辨率解耦（换分辨率不用重设规则）。
 *
 * 判定是纯函数，与 Canvas 无关，可单元测试。
 */
import type { FeatureKind, MapFeature } from "./types";

/** 单个对象类型的显示规则 */
export interface FeatureVisibilityRule {
  /** 小于该屏幕尺寸（px）时不显示，0 表示不限 */
  minScreenSize: number;
  /** 大于该屏幕尺寸（px）时不显示（用于「放大后小点让位给面」），0 表示不限 */
  maxScreenSize: number;
  /** 是否显示标签 */
  showLabel: boolean;
  /** 标签可读的最小屏幕字号（px），低于此值不绘制文字 */
  minLabelFontPx: number;
  /** 小比例下保留的最小重要度（1~5），值越小保留越多 */
  minImportance: number;
}

/** 图层级的显示规则：按对象类型分别给出 */
export type LayerVisibilityRule = Partial<Record<FeatureKind, FeatureVisibilityRule>>;

/** 判定上下文 */
export interface VisibilityContext {
  /** 当前视图缩放倍数 */
  zoom: number;
  /** 对象在该图层中的基础屏幕尺寸（px @ zoom = 1），由渲染器提供 */
  baseScreenSize: number;
  /** 图层级规则 */
  rule: FeatureVisibilityRule;
}

/**
 * 默认显示规则表（按对象类型给）。
 * 数值对应方案 §10.3 的默认预设：国界与地名在小比例下也保留，
 * 据点与细节符号随放大逐步出现。
 * @returns 默认规则表
 */
export function defaultVisibilityRules(): Required<LayerVisibilityRule> {
  return {
    // 面：国界 / 势力范围 —— 任何比例都显示，只是线宽变化
    area: {
      minScreenSize: 0,
      maxScreenSize: 0,
      showLabel: true,
      minLabelFontPx: 11,
      minImportance: 1,
    },
    // 折线：河流 / 边界
    border: {
      minScreenSize: 2,
      maxScreenSize: 0,
      showLabel: true,
      minLabelFontPx: 11,
      minImportance: 2,
    },
    // 路线：贸易路线 / 航线
    route: {
      minScreenSize: 4,
      maxScreenSize: 0,
      showLabel: true,
      minLabelFontPx: 11,
      minImportance: 3,
    },
    // 箭头：进军方向，太小时看不出方向就没有意义
    arrow: {
      minScreenSize: 12,
      maxScreenSize: 0,
      showLabel: false,
      minLabelFontPx: 11,
      minImportance: 3,
    },
    // 符号：城市 / 据点 —— 小比例下只留重要度高的
    symbol: {
      minScreenSize: 6,
      maxScreenSize: 0,
      showLabel: true,
      minLabelFontPx: 11,
      minImportance: 4,
    },
    // 文字：地名注记 —— 小于可读字号就不画
    text: {
      minScreenSize: 0,
      maxScreenSize: 0,
      showLabel: true,
      minLabelFontPx: 11,
      minImportance: 4,
    },
  };
}

/**
 * 合并图层规则与默认规则，得到某对象类型的最终规则。
 * @param rules 图层自定义规则（可为空）
 * @param kind 对象类型
 * @returns 合并后的规则
 */
export function resolveRule(rules: LayerVisibilityRule | undefined, kind: FeatureKind): FeatureVisibilityRule {
  const defaults = defaultVisibilityRules();
  const base = defaults[kind];
  const custom = rules?.[kind];
  return custom ? { ...base, ...custom } : base;
}

/**
 * 计算对象在当前缩放下占用的屏幕尺寸。
 * @param baseScreenSize 该对象在 1× 时的屏幕尺寸（px）
 * @param zoom 当前缩放倍数
 * @returns 屏幕尺寸（px）
 */
export function screenSizeAt(baseScreenSize: number, zoom: number): number {
  return baseScreenSize * zoom;
}

/**
 * 判断一个要素在当前缩放下是否应显示。
 *
 * 优先级：`alwaysVisible` > 对象重要度 > 屏幕尺寸区间 > 标签字号。
 * @param feature 要素
 * @param context 判定上下文
 * @returns 需要绘制时返回 true
 */
export function shouldRenderFeature(feature: MapFeature, context: VisibilityContext): boolean {
  if (feature.alwaysVisible) {
    return true;
  }
  const { rule } = context;
  if (feature.importance < rule.minImportance) {
    return false;
  }
  const size = screenSizeAt(context.baseScreenSize, context.zoom);
  if (rule.minScreenSize > 0 && size < rule.minScreenSize) {
    return false;
  }
  if (rule.maxScreenSize > 0 && size > rule.maxScreenSize) {
    return false;
  }
  return true;
}

/**
 * 判断要素的标签是否应绘制（另有字号与开关两道限制）。
 * @param feature 要素
 * @param context 判定上下文
 * @param fontPx 当前缩放下标签的屏幕字号（px）
 * @returns 需要绘制标签时返回 true
 */
export function shouldRenderLabel(
  feature: MapFeature,
  context: VisibilityContext,
  fontPx: number,
): boolean {
  if (!feature.label) {
    return false;
  }
  if (!context.rule.showLabel) {
    return false;
  }
  return fontPx >= context.rule.minLabelFontPx;
}

/**
 * 批量过滤要素，返回应绘制的部分与被隐藏的数量。
 *
 * 过滤放在绘制之前，因此小比例下的绘制量与内存开销同步下降。
 * @param features 候选要素
 * @param options 公共参数：缩放、各要素基础尺寸、图层规则
 * @returns 应绘制要素与被隐藏数量
 */
export function filterRenderableFeatures(
  features: MapFeature[],
  options: {
    zoom: number;
    rules?: LayerVisibilityRule;
    /** 按对象类型给出的基础屏幕尺寸（px @ 1×），默认全部按 10px 估算 */
    baseSizes?: Partial<Record<FeatureKind, number>>;
  },
): { visible: MapFeature[]; hiddenCount: number } {
  const visible: MapFeature[] = [];
  let hiddenCount = 0;
  for (const feature of features) {
    // 文字类要素自身没有几何尺寸，用字号近似
    const base = options.baseSizes?.[feature.kind] ?? (feature.kind === "text" ? 12 : 10);
    const rule = resolveRule(options.rules, feature.kind);
    const keep = shouldRenderFeature(feature, { zoom: options.zoom, baseScreenSize: base, rule });
    if (keep) {
      visible.push(feature);
    } else {
      hiddenCount += 1;
    }
  }
  return { visible, hiddenCount };
}

/**
 * 计算标注字号在当前缩放下的屏幕像素（用于「字号随缩放衰减」的可选行为）。
 * @param baseFontPx 基准字号（px @ 1×）
 * @param zoom 当前缩放倍数
 * @param decay 衰减指数：1 = 完全跟随缩放；0.5 = 折半跟随
 * @returns 屏幕字号（px）
 */
export function labelFontPx(baseFontPx: number, zoom: number, decay = 0.5): number {
  return baseFontPx * Math.pow(Math.max(zoom, 1e-6), decay);
}
