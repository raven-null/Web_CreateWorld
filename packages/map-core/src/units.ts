/**
 * 自适应单位系统（方案 §7.4）。
 *
 * 设计要点：单位做成**可扩展的注册表**而不是写死的分支，
 * 将来增加「里 / 丈」等自定义单位、或做「世界级度量衡」时，
 * 只需追加表项，比例尺、测量、面积统计的代码都不用改。
 *
 * 内部一律以 km 计算，单位只在显示层生效 —— 所以换单位不影响任何已有数据。
 */
import { EARTH_RADIUS_KM } from "./geo-distance";

/** 单位定义：换算基准统一为 km */
export interface DistanceUnit {
  /** 稳定标识 */
  id: string;
  /** 显示名 */
  name: string;
  /** 符号（km / AU / ly） */
  symbol: string;
  /** 1 个单位等于多少 km */
  kmPerUnit: number;
  /** 该单位适用的实距上限（km，不含）；用于自动选择 */
  appliesBelowKm: number;
}

/** 距离参照物：帮助用户建立直觉（「≈ 1.2 个地球直径」） */
export interface DistanceReference {
  id: string;
  name: string;
  km: number;
}

/**
 * 默认单位注册表（已定案：km / AU / 光年）。
 * 顺序按适用量级从小到大，未列入注册表的实距会自动派生更大的单位。
 */
export const DEFAULT_DISTANCE_UNITS: DistanceUnit[] = [
  { id: "m", name: "米", symbol: "m", kmPerUnit: 0.001, appliesBelowKm: 1 },
  { id: "km", name: "千米", symbol: "km", kmPerUnit: 1, appliesBelowKm: 1e6 },
  { id: "au", name: "天文单位", symbol: "AU", kmPerUnit: 1.495978707e8, appliesBelowKm: 1e10 },
  { id: "ly", name: "光年", symbol: "ly", kmPerUnit: 9.4607304725808e12, appliesBelowKm: Number.POSITIVE_INFINITY },
];

/** 默认对照参考物（按量级排列，选取时找最接近的） */
export const DEFAULT_DISTANCE_REFERENCES: DistanceReference[] = [
  { id: "nile", name: "尼罗河", km: 6650 },
  { id: "earth-diameter", name: "地球直径", km: 12742 },
  { id: "china-width", name: "中国东西跨度", km: 5200 },
  { id: "moon", name: "地月距离", km: 384400 },
  { id: "earth-circumference", name: "地球赤道周长", km: 40030 },
  { id: "sun", name: "日地距离", km: 1.495978707e8 },
  { id: "sun-diameter", name: "太阳直径", km: 1392000 },
  { id: "ly", name: "光年", km: 9.4607304725808e12 },
];

/**
 * 按实距选择最合适的单位。
 * 注册表里没有覆盖到的量级时，自动派生 10ⁿ 千米单位，保证数字始终可读。
 * @param km 实距（km）
 * @param units 单位注册表（默认使用内置表）
 * @returns 选中的单位
 */
export function pickUnit(km: number, units: DistanceUnit[] = DEFAULT_DISTANCE_UNITS): DistanceUnit {
  const absolute = Math.abs(km);
  const sorted = [...units].sort((a, b) => a.appliesBelowKm - b.appliesBelowKm);
  for (const unit of sorted) {
    if (absolute < unit.appliesBelowKm) {
      return unit;
    }
  }
  const last = sorted[sorted.length - 1];
  if (last && absolute < last.appliesBelowKm) {
    return last;
  }
  // 超出注册表覆盖范围：派生以 10ⁿ 千米为单位的读数
  const exponent = Math.floor(Math.log10(absolute));
  return {
    id: `km1e${exponent}`,
    name: "千米",
    symbol: "km",
    kmPerUnit: Math.pow(10, exponent),
    appliesBelowKm: Number.POSITIVE_INFINITY,
  };
}

/**
 * 数字格式化：保留两位有效数字，去掉多余的零。
 * @param value 待格式化的数值
 * @returns 可读字符串（如 9.8 / 9980 / 1.2e6）
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (value === 0) {
    return "0";
  }
  const absolute = Math.abs(value);
  if (absolute >= 1e6) {
    return value.toExponential(1).replace("e+", "e");
  }
  if (absolute >= 100) {
    return String(Math.round(value));
  }
  const digits = absolute >= 1 ? 1 : 2;
  return String(Number(value.toFixed(digits)));
}

/**
 * 把实距格式化成带单位的字符串。
 * @param km 实距（km）
 * @param units 单位注册表
 * @returns 形如 "9.8 km" / "1.5 AU" 的字符串
 */
export function formatDistance(km: number, units: DistanceUnit[] = DEFAULT_DISTANCE_UNITS): string {
  const unit = pickUnit(km, units);
  return `${formatNumber(km / unit.kmPerUnit)} ${unit.symbol}`;
}

/**
 * 返回最接近的对照参考物。
 * @param km 实距（km）
 * @param references 参考物列表
 * @returns 参考物与倍数；列表为空时返回 null
 */
export function nearestReference(
  km: number,
  references: DistanceReference[] = DEFAULT_DISTANCE_REFERENCES,
): { reference: DistanceReference; times: number } | null {
  if (references.length === 0) {
    return null;
  }
  const absolute = Math.abs(km);
  let best = references[0];
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const reference of references) {
    // 用对数距离比较更符合量级直觉
    const diff = Math.abs(Math.log10(absolute) - Math.log10(reference.km));
    if (diff < bestDiff) {
      best = reference;
      bestDiff = diff;
    }
  }
  if (!best || best.km === 0) {
    return null;
  }
  return { reference: best, times: km / best.km };
}

/**
 * 把实距格式化为「≈ N 个参考物」的说明文字。
 * @param km 实距（km）
 * @param references 参考物列表
 * @returns 形如 "≈ 1.5 个地球直径"；无可用参考物时返回空串
 */
export function describeByReference(
  km: number,
  references: DistanceReference[] = DEFAULT_DISTANCE_REFERENCES,
): string {
  const nearest = nearestReference(km, references);
  if (!nearest) {
    return "";
  }
  return `≈ ${formatNumber(nearest.times)} 个${nearest.reference.name}`;
}

/**
 * 把面积格式化成中文习惯的读数。
 * @param km2 面积（km²）
 * @returns 形如 "810 万 km²" / "3900 km²"
 */
export function formatArea(km2: number): string {
  const absolute = Math.abs(km2);
  if (absolute >= 1e8) {
    return `${formatNumber(km2 / 1e8)} 亿 km²`;
  }
  if (absolute >= 1e4) {
    return `${formatNumber(km2 / 1e4)} 万 km²`;
  }
  return `${formatNumber(km2)} km²`;
}

/**
 * 计算面积占天体总表面的百分比。
 * @param areaKm2 面积（km²）
 * @param radiusKm 天体半径（km）
 * @returns 百分比（0~100）
 */
export function areaPercentOfSurface(areaKm2: number, radiusKm: number): number {
  const total = 4 * Math.PI * radiusKm * radiusKm;
  return total > 0 ? (areaKm2 / total) * 100 : 0;
}

/** 地球半径兜底导出（供调用方少引一个模块） */
export const DEFAULT_RADIUS_KM = EARTH_RADIUS_KM;
