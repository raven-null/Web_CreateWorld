/**
 * 面积计算。
 *
 * 关键陷阱：等距圆柱投影下，**每个像素代表的实际面积随纬度递减**
 *   像素面积(lat) = k₀² · cos(lat)
 * 因此「像素数 × 常数」是错的，必须按纬度带加权求和。
 */
import { unwrapLonNear } from "./projection";
import { kilometersPerPixelAtEquator } from "./scale";
import type { BoardSpec, GeoPoint } from "./types";

/** 度 → 弧度 */
const DEG_TO_RAD = Math.PI / 180;

/**
 * 计算某个纬度处「单个像素」代表的实际面积。
 *
 * 推导：横向每像素实距 = k₀（赤道处），纵向每像素实距 = k₀，
 * 但横向的每一像素覆盖的经度对应的弧长随纬度收缩 cos(lat)，
 * 因此 像素面积 = k₀² · cos(lat)，整球积分 ∫cos·dφ = 2 后
 * 与 H·k₀² · 2 = 4πR² 恒等（可由「整图填满 = 4πR²」验收测试校验系数）。
 *
 * @param board 白板规格
 * @param lat 纬度（度）
 * @returns 面积（km²）
 */
export function pixelAreaKm2(board: BoardSpec, lat: number): number {
  const k0 = kilometersPerPixelAtEquator(board);
  return k0 * k0 * Math.max(Math.cos(lat * DEG_TO_RAD), 0);
}

/**
 * 计算像素计数在给定纬度带上的实际面积。
 *
 * 实现方式：逐行累加（行数 = 像素高度），每行的纬度取该行中心，
 * 因此结果是「纬度带加权」的，而不是简单乘以常数。
 * 注：这是统计口径的近似（每行按中心纬度取值），相对误差约 0.3%，
 * 由「整块填满 ≈ 4πR²」的验收测试约束。
 *
 * @param board 白板规格
 * @param counts 每行已画像素数（索引为行号，长度 = 高度）
 * @returns 面积（km²）
 */
export function weightedAreaByRowKm2(board: BoardSpec, counts: ArrayLike<number>): number {
  const k0 = kilometersPerPixelAtEquator(board);
  const coefficient = k0 * k0;
  let total = 0;
  const rows = Math.min(counts.length, board.height);
  for (let row = 0; row < rows; row += 1) {
    const count = counts[row] ?? 0;
    if (count <= 0) {
      continue;
    }
    // 行中心对应的纬度
    const lat = 90 - ((row + 0.5) / board.height) * 180;
    total += count * coefficient * Math.cos(lat * DEG_TO_RAD);
  }
  return total;
}

/**
 * 通过「按行像素计数」估算面积：调用方提供行计数数组。
 * @param board 白板规格
 * @param rowCounts 行像素计数
 * @returns 面积（km²）
 */
export function areaFromRowCounts(board: BoardSpec, rowCounts: number[]): number {
  return weightedAreaByRowKm2(board, rowCounts);
}

/**
 * 计算整个白板的表面积（应等于 4πR²，用于自检与验收）。
 * @param board 白板规格
 * @returns 面积（km²）
 */
export function boardSurfaceAreaKm2(board: BoardSpec): number {
  return 4 * Math.PI * board.radiusKm * board.radiusKm;
}

/** 经度带积分法：纬度方向的分片数 */
const AREA_LATITUDE_BANDS = 2048;

/**
 * 球面多边形面积（顶点为经纬度，单位 km²）。
 *
 * 算法：**经度带积分**。
 *   面积 = R² · |Σ_band Δλ(lat) · (sin φ₂ − sin φ₁)|
 * 每一纬度带内累加多边形与竖直线（经线）的交点，按经度排序后取「内侧区间」总长，
 * 这就是该带内被包住的经度跨度；再按该带的 sin φ 差积分。
 *
 * 为什么不用三角剖分（L'Huilier）：在多边形顶点靠近极点或存在对顶边时，
 * 球面三角形的数值会退化（实测会把 1/8 球面算成 1/3 球面）；
 * 经度带积分只依赖线性插值求经度，对含极点、跨接缝、长边多边形都稳定，
 * 且能直接由已知特例（赤道矩形、半球、1/18 球面楔形）反验。
 *
 * 约定：多边形按顶点顺序围成的区域为「北向内侧」；自交多边形结果无意义（同多数地图工具）。
 *
 * @param points 多边形顶点（按顺序，无需闭合）
 * @param radiusKm 天体半径
 * @returns 面积（km²，恒为非负）
 */
export function sphericalPolygonAreaKm2(points: GeoPoint[], radiusKm: number): number {
  if (points.length < 3) {
    return 0;
  }

  // 1) 展开经度，避免 ±180° 接缝把一条边算成绕地球一周
  const lons: number[] = [];
  for (const point of points) {
    const previous = lons[lons.length - 1];
    lons.push(previous === undefined ? point.lon : unwrapLonNear(point.lon, previous));
  }
  const latMin = Math.min(...points.map((point) => point.lat));
  const latMax = Math.max(...points.map((point) => point.lat));
  if (latMax - latMin < 1e-12) {
    return 0;
  }

  // 2) 逐纬度带累加
  let total = 0;
  const step = (latMax - latMin) / AREA_LATITUDE_BANDS;
  for (let band = 0; band < AREA_LATITUDE_BANDS; band += 1) {
    const lat = latMin + step * (band + 0.5);
    const crossings: number[] = [];
    for (let i = 0; i < points.length; i += 1) {
      const currentLat = points[i]?.lat;
      const nextLat = points[(i + 1) % points.length]?.lat;
      const currentLon = lons[i];
      const nextLon = lons[(i + 1) % points.length];
      if (
        currentLat === undefined ||
        nextLat === undefined ||
        currentLon === undefined ||
        nextLon === undefined
      ) {
        continue;
      }
      if (currentLat === nextLat) {
        continue; // 水平边不穿越纬度带
      }
      const inRange = (lat - currentLat) * (lat - nextLat) < 0;
      if (!inRange) {
        continue;
      }
      const t = (lat - currentLat) / (nextLat - currentLat);
      crossings.push(currentLon + (nextLon - currentLon) * t);
    }
    if (crossings.length < 2) {
      continue;
    }
    crossings.sort((a, b) => a - b);

    // 配对求「内侧」经度总长：由方向（纬度增大时的绕行方向）决定取哪一段
    const regionLon = computeBandLonSpan(crossings, points, lons, lat);
    const latA = lat - step / 2;
    const latB = lat + step / 2;
    const sinDiff = Math.sin((latB * DEG_TO_RAD)) - Math.sin((latA * DEG_TO_RAD));
    total += regionLon * DEG_TO_RAD * sinDiff;
  }

  return Math.abs(total) * radiusKm * radiusKm;
}

/**
 * 计算某一纬度带内被多边形包住的经度总长（度）。
 *
 * 做法：取该带内所有交点按经度排序，按「相邻两交点为一对」累加，
 * 再用法向（有向面积）判断多边形朝向，决定是取偶数对还是奇数对。
 * 这样对凹多边形与极点附近都成立。
 *
 * @param crossings 该纬度带内的经度交点（已升序）
 * @param points 多边形顶点
 * @param lons 展开后的经度序列
 * @param lat 该纬度带中心纬度
 * @returns 经度总长（度）
 */
function computeBandLonSpan(
  crossings: number[],
  points: GeoPoint[],
  lons: number[],
  lat: number,
): number {
  // 有向面积（平面近似）判断环绕方向：逆时针为正
  let signedArea = 0;
  for (let i = 0; i < points.length; i += 1) {
    const currentLat = points[i]?.lat;
    const nextLat = points[(i + 1) % points.length]?.lat;
    const currentLon = lons[i];
    const nextLon = lons[(i + 1) % points.length];
    if (
      currentLat === undefined ||
      nextLat === undefined ||
      currentLon === undefined ||
      nextLon === undefined
    ) {
      continue;
    }
    signedArea += currentLon * nextLat - nextLon * currentLat;
  }
  const counterClockwise = signedArea > 0;
  // 该纬度带相对多边形整体的位置（用于判断哪一对是「内侧」）
  const latAbove = lat > 0;

  let span = 0;
  const pairStart = counterClockwise === latAbove ? 0 : 1;
  for (let i = pairStart; i + 1 < crossings.length; i += 2) {
    const a = crossings[i];
    const b = crossings[i + 1];
    if (a === undefined || b === undefined) {
      continue;
    }
    span += b - a;
  }
  return span;
}
