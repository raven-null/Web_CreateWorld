/**
 * 投影换算：经纬度 ↔ 平面归一化 ↔ 平面像素 ↔ 球面坐标。
 *
 * 采用等距圆柱投影：
 *   u = (lon + 180) / 360      ∈ [0, 1]
 *   v = (90 - lat) / 180       ∈ [0, 1]（原点在上，与数据库里 markers.x / y 同向）
 *
 * 关键性质：白板保持 2:1 时，平面白板恰好等于一套完整球面贴图，
 * 且像素是正方形（经、纬两方向的每像素实距数值相同）。
 *
 * 本文件是纯函数，不得出现任何平台 API（window / document / fetch …）。
 */
import type { BoardSpec, GeoPoint, UvPoint } from "./types";

/** 经度的合法范围（度） */
export const LON_MIN = -180;
/** 经度的合法范围（度） */
export const LON_MAX = 180;
/** 纬度的合法范围（度） */
export const LAT_MIN = -90;
/** 纬度的合法范围（度） */
export const LAT_MAX = 90;

/** 弧度换算常量 */
const DEG_TO_RAD = Math.PI / 180;

/**
 * 经度取模回绕到 [-180, 180)。
 * 纬度不环绕（越过极点没有意义，由调用方决定丢弃或裁剪）。
 * @param lon 任意经度值
 * @returns 回绕后的经度
 */
export function wrapLon(lon: number): number {
  const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
  return wrapped;
}

/**
 * 把经度平移到离参考经度最近的那个「圈」，用于跨接缝的连续绘制。
 * @param lon 待调整的经度
 * @param referenceLon 参考经度
 * @returns 与参考值差值不超过 180° 的等价经度（可能超出 [-180,180]）
 */
export function unwrapLonNear(lon: number, referenceLon: number): number {
  let value = lon;
  while (value - referenceLon > 180) {
    value -= 360;
  }
  while (value - referenceLon < -180) {
    value += 360;
  }
  return value;
}

/**
 * 经纬度 → 平面归一化坐标（0~1，原点左上）。
 * @param lon 经度（度）
 * @param lat 纬度（度）
 * @returns 归一化平面坐标
 */
export function lonLatToUv(lon: number, lat: number): UvPoint {
  return {
    u: (lon - LON_MIN) / 360,
    v: (LAT_MAX - lat) / 180,
  };
}

/**
 * 平面归一化坐标 → 经纬度。
 * @param u 归一化横坐标
 * @param v 归一化纵坐标
 * @returns 经纬度（度）
 */
export function uvToLonLat(u: number, v: number): GeoPoint {
  return {
    lon: u * 360 + LON_MIN,
    lat: LAT_MAX - v * 180,
  };
}

/**
 * 经纬度 → 平面像素坐标。
 * 结果可能略超出 [0, width] / [0, height]（经度环绕或浮点误差），由调用方裁剪。
 * @param point 地理坐标
 * @param board 白板规格
 * @returns 像素坐标
 */
export function lonLatToPixel(point: GeoPoint, board: BoardSpec): { x: number; y: number } {
  const { u, v } = lonLatToUv(point.lon, point.lat);
  return { x: u * board.width, y: v * board.height };
}

/**
 * 平面像素坐标 → 经纬度。
 * @param x 像素横坐标
 * @param y 像素纵坐标
 * @param board 白板规格
 * @returns 地理坐标
 */
export function pixelToLonLat(x: number, y: number, board: BoardSpec): GeoPoint {
  return uvToLonLat(x / board.width, y / board.height);
}

/**
 * 平面像素坐标 → 归一化坐标（写入 markers.x / y 前使用）。
 * @param x 像素横坐标
 * @param y 像素纵坐标
 * @param board 白板规格
 * @returns 归一化坐标（未裁剪，可能因环绕略微超出 0~1）
 */
export function pixelToUv(x: number, y: number, board: BoardSpec): UvPoint {
  return { u: x / board.width, v: y / board.height };
}

/**
 * 经纬度 → 单位球坐标（半径 1，右手系：x 向右、y 向上、z 朝向观察者初始位置）。
 * 用于 3D 地球仪的顶点计算与拾取。
 * @param lon 经度（度）
 * @param lat 纬度（度）
 * @returns 单位球上的三维坐标
 */
export function lonLatToSphere(lon: number, lat: number): { x: number; y: number; z: number } {
  const phi = lat * DEG_TO_RAD;
  const lambda = lon * DEG_TO_RAD;
  const cosPhi = Math.cos(phi);
  return {
    x: cosPhi * Math.sin(lambda),
    y: Math.sin(phi),
    z: cosPhi * Math.cos(lambda),
  };
}

/**
 * 单位球坐标 → 经纬度（3D 拾取时使用）。
 * @param point 单位球上的三维坐标（不必严格归一化）
 * @returns 地理坐标
 */
export function sphereToLonLat(point: { x: number; y: number; z: number }): GeoPoint {
  const length = Math.hypot(point.x, point.y, point.z);
  if (length === 0) {
    return { lon: 0, lat: 0 };
  }
  const x = point.x / length;
  const y = point.y / length;
  const z = point.z / length;
  const lat = Math.asin(y) / DEG_TO_RAD;
  const lon = Math.atan2(x, z) / DEG_TO_RAD;
  return { lon, lat };
}

/**
 * 白板每方向有多少个瓦片。
 * @param width 白板宽度
 * @param height 白板高度
 * @param tileSize 瓦片边长（默认 256）
 * @returns 瓦片列数与行数
 */
export function tileGridSize(
  width: number,
  height: number,
  tileSize = 256,
): { cols: number; rows: number } {
  return {
    cols: Math.ceil(width / tileSize),
    rows: Math.ceil(height / tileSize),
  };
}

/**
 * 判断白板是否满足 2:1 约束（「平面白板 = 完整球面贴图」的数学前提）。
 * @param width 白板宽度
 * @param height 白板高度
 * @returns 满足返回 true
 */
export function isBoardRatioValid(width: number, height: number): boolean {
  return height * 2 === width;
}
