/**
 * 球面距离与方位角。
 *
 * 关键陷阱：2D 平面上的「直线」在球面上并不是最短路径（测地线），
 * 只有赤道与经线例外。因此长距离测量必须用 haversine，而不是「像素距离 × 比例尺」。
 */
import { lonLatToSphere } from "./projection";
import type { GeoPoint } from "./types";

/** 地球平均半径（km），作为默认值 */
export const EARTH_RADIUS_KM = 6371;

/** 度 → 弧度 */
const DEG_TO_RAD = Math.PI / 180;

/**
 * 两点间的球面最短距离（haversine）。
 * @param a 起点
 * @param b 终点
 * @param radiusKm 天体半径（km）
 * @returns 距离（km）
 */
export function sphericalDistanceKm(a: GeoPoint, b: GeoPoint, radiusKm = EARTH_RADIUS_KM): number {
  const phi1 = a.lat * DEG_TO_RAD;
  const phi2 = b.lat * DEG_TO_RAD;
  const deltaPhi = (b.lat - a.lat) * DEG_TO_RAD;
  const deltaLambda = (b.lon - a.lon) * DEG_TO_RAD;

  const sinHalfPhi = Math.sin(deltaPhi / 2);
  const sinHalfLambda = Math.sin(deltaLambda / 2);
  const h = sinHalfPhi * sinHalfPhi + Math.cos(phi1) * Math.cos(phi2) * sinHalfLambda * sinHalfLambda;
  const clamped = Math.min(1, Math.max(0, h));
  return 2 * radiusKm * Math.asin(Math.sqrt(clamped));
}

/**
 * 同一纬线上两点之间的距离（沿纬线的弧长）。
 * @param lonA 起点经度
 * @param lonB 终点经度
 * @param lat 纬度
 * @param radiusKm 天体半径
 * @returns 距离（km）
 */
export function alongParallelDistanceKm(
  lonA: number,
  lonB: number,
  lat: number,
  radiusKm = EARTH_RADIUS_KM,
): number {
  const deltaLon = Math.abs(lonB - lonA) * Math.cos(lat * DEG_TO_RAD);
  return (deltaLon * Math.PI * radiusKm) / 180;
}

/**
 * 沿经线方向的南北距离。
 * @param latA 起点纬度
 * @param latB 终点纬度
 * @param radiusKm 天体半径
 * @returns 距离（km）
 */
export function alongMeridianDistanceKm(
  latA: number,
  latB: number,
  radiusKm = EARTH_RADIUS_KM,
): number {
  return (Math.abs(latB - latA) * Math.PI * radiusKm) / 180;
}

/**
 * 起点指向终点的初始方位角（从正北顺时针，0~360）。
 * @param a 起点
 * @param b 终点
 * @returns 方位角（度）
 */
export function initialBearing(a: GeoPoint, b: GeoPoint): number {
  const phi1 = a.lat * DEG_TO_RAD;
  const phi2 = b.lat * DEG_TO_RAD;
  const deltaLambda = (b.lon - a.lon) * DEG_TO_RAD;

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const bearing = Math.atan2(y, x) / DEG_TO_RAD;
  return (bearing + 360) % 360;
}

/**
 * 折线累计长度。
 * @param points 折线顶点（经纬度）
 * @param radiusKm 天体半径
 * @returns 总长度（km）
 */
export function polylineLengthKm(points: GeoPoint[], radiusKm = EARTH_RADIUS_KM): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const current = points[i];
    if (!prev || !current) {
      continue;
    }
    total += sphericalDistanceKm(prev, current, radiusKm);
  }
  return total;
}

/**
 * 把两点转成单位向量（供包围盒与球面几何复用）。
 * @param point 地理坐标
 * @returns 单位球向量
 */
export function toUnitVector(point: GeoPoint): { x: number; y: number; z: number } {
  return lonLatToSphere(point.lon, point.lat);
}

/**
 * 计算一组点的经度跨度，自动处理跨接缝（±180°）情形。
 * @param lons 经度列表
 * @returns 最小外接经度区间；跨越接缝时 from > to
 */
export function longitudeSpan(lons: number[]): { from: number; to: number } {
  if (lons.length === 0) {
    return { from: 0, to: 0 };
  }
  // 若首尾以内存在跨越（最大间隔 > 180°），则取补集作为外接区间
  const sorted = [...lons].sort((a, b) => a - b);
  let maxGap = 0;
  let gapIndex = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    const next = i === sorted.length - 1 ? (sorted[0] ?? 0) + 360 : (sorted[i + 1] ?? 0);
    if (current === undefined || next === undefined) {
      continue;
    }
    const gap = next - current;
    if (gap > maxGap) {
      maxGap = gap;
      gapIndex = i;
    }
  }
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  if (maxGap <= 180) {
    return { from: min, to: max };
  }
  // 跨越接缝：外接区间从排序后的下一个元素开始，绕回前一个元素
  const start = sorted[(gapIndex + 1) % sorted.length] ?? 0;
  const endRaw = sorted[gapIndex] ?? 0;
  return { from: start, to: endRaw > start ? endRaw : endRaw + 360 };
}

/**
 * 判断一个点是否落在经纬度视口内（自动处理经度环绕）。
 * @param point 待判断的点
 * @param viewport 视口范围（from > to 表示跨越接缝）
 * @returns 在视口内返回 true
 */
export function isPointInViewport(
  point: GeoPoint,
  viewport: { minLon: number; maxLon: number; minLat: number; maxLat: number },
): boolean {
  if (point.lat < viewport.minLat || point.lat > viewport.maxLat) {
    return false;
  }
  const { minLon, maxLon } = viewport;
  if (minLon <= maxLon) {
    return point.lon >= minLon && point.lon <= maxLon;
  }
  // 跨越接缝：命中任一段即算在视口内
  return point.lon >= minLon || point.lon <= maxLon;
}
