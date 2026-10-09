/**
 * 测量（距离 / 方位角 / 面积）与尺度统计。
 *
 * 设计要点（方案 §7.5 / §7.6）：
 * - 距离一律用 **haversine**（球面最短路径），而不是「像素距离 × 比例尺」：
 *   2D 平面上的直线在球面上是曲线，长距离用像素估算会明显偏小
 * - 面积一律**按纬度带加权**（每像素代表的实际面积随纬度衰减 `cos(lat)`），
 *   不能用「像素数 × 常数」
 * - 统计采用**逐行计数**：行数 = 白板高（2048 时两千次循环），一次全图统计在毫秒级，
 *   因此不必上复杂的增量结构；用户点「统计」时即时算即可
 */
import {
  areaFromRowCounts,
  boardSurfaceAreaKm2,
  initialBearing,
  polylineLengthKm,
  sphericalDistanceKm,
  type BoardSpec,
  type GeoPoint,
} from "@worldmap/core";

/** 测量结果：折线累计距离、直线距离与方位角 */
export interface MeasureResult {
  /** 各折点（经纬度） */
  points: GeoPoint[];
  /** 折线累计长度（km，沿折线逐段求和） */
  polylineKm: number;
  /** 起点到终点的直线（球面最短）距离（km） */
  directKm: number;
  /** 起点指向终点的初始方位角（度，0 = 正北） */
  directBearing: number;
  /** 各段长度（km） */
  segmentsKm: number[];
}

/**
 * 计算一次测量的结果。
 * @param points 折点（经纬度，至少两点）
 * @param radiusKm 天体半径
 * @returns 测量结果；点数不足时返回 null
 */
export function measurePolyline(points: GeoPoint[], radiusKm: number): MeasureResult | null {
  if (points.length < 2) {
    return null;
  }
  const segmentsKm: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (!previous || !current) {
      continue;
    }
    segmentsKm.push(sphericalDistanceKm(previous, current, radiusKm));
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return null;
  }
  return {
    points,
    polylineKm: polylineLengthKm(points, radiusKm),
    directKm: sphericalDistanceKm(first, last, radiusKm),
    directBearing: initialBearing(first, last),
    segmentsKm,
  };
}

/** 按地形类型汇总的统计结果 */
export interface TerrainStat {
  /** 地形名（来自调色板） */
  name: string;
  color: string;
  /** 已画像素数 */
  pixels: number;
  /** 实际面积（km²，已按纬度带加权） */
  areaKm2: number;
}

/** 整幅栅格的统计结果 */
export interface RasterStats {
  /** 各地形类型的统计（按面积从大到小） */
  terrains: TerrainStat[];
  /** 已画总面积（km²） */
  paintedKm2: number;
  /** 天体总表面积（km²） */
  surfaceKm2: number;
  /** 已画面积占天体表面的百分比 */
  paintedPercent: number;
}

/**
 * 统计整幅索引栅格的各地形面积。
 *
 * 实现：先按行统计「每个地形类型在该行的像素数」，再用 `areaFromRowCounts`
 * 做纬度带加权。这样只遍历一次像素，且复用了内核里已被单测覆盖的面积算法。
 *
 * @param indices 全幅索引栅格（行优先）
 * @param width 白板宽
 * @param height 白板高
 * @param palette 调色板（下标 → 名称与颜色）
 * @param board 白板规格（含半径）
 * @returns 统计结果
 */
export function computeRasterStats(
  indices: Uint8Array,
  width: number,
  height: number,
  palette: { index: number; name: string; color: string }[],
  board: BoardSpec,
): RasterStats {
  // 每行 × 每个下标 的像素计数：用 Map 稀疏存储，避免 maxIndex × height 的二维数组
  const rowCounts = new Map<number, number[]>();
  const totalByIndex = new Map<number, number>();

  for (let row = 0; row < height; row += 1) {
    const rowStart = row * width;
    const counts = new Int32Array(256);
    for (let col = 0; col < width; col += 1) {
      const value = indices[rowStart + col] ?? 0;
      if (value === 0) {
        continue; // 透明不计
      }
      counts[value] = (counts[value] ?? 0) + 1;
      totalByIndex.set(value, (totalByIndex.get(value) ?? 0) + 1);
    }
    // 只保留本行出现过的下标，省内存
    for (let index = 1; index < 256; index += 1) {
      const count = counts[index] ?? 0;
      if (count === 0) {
        continue;
      }
      let rows = rowCounts.get(index);
      if (!rows) {
        rows = new Array<number>(height).fill(0);
        rowCounts.set(index, rows);
      }
      rows[row] = count;
    }
  }

  const terrains: TerrainStat[] = [];
  let paintedKm2 = 0;
  for (const [index, rows] of rowCounts) {
    const areaKm2 = areaFromRowCounts(board, rows);
    paintedKm2 += areaKm2;
    const brush = palette.find((item) => item.index === index);
    terrains.push({
      name: brush?.name ?? `地形 ${index}`,
      color: brush?.color ?? "#888888",
      pixels: totalByIndex.get(index) ?? 0,
      areaKm2,
    });
  }
  terrains.sort((a, b) => b.areaKm2 - a.areaKm2);

  const surfaceKm2 = boardSurfaceAreaKm2(board);
  return {
    terrains,
    paintedKm2,
    surfaceKm2,
    paintedPercent: surfaceKm2 > 0 ? (paintedKm2 / surfaceKm2) * 100 : 0,
  };
}

/**
 * 在信息条上用的紧凑读数：给出一组地形的「占比最高项」。
 * @param stats 统计结果
 * @returns 面积最大的地形；没有绘制内容时返回 null
 */
export function dominantTerrain(stats: RasterStats): TerrainStat | null {
  return stats.terrains[0] ?? null;
}
