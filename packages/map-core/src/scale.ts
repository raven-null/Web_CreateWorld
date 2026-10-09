/**
 * 比例尺与尺度换算（方案第 7 章）。
 *
 * 核心结论：**等距圆柱投影下比例尺随纬度变化**
 *   每 1° 经度的实距 = (πR/180)·cos(lat)，越靠两极越短
 *   每 1° 纬度的实距 = πR/180，恒定不变
 * 因此不能放一根固定的比例尺条，必须按光标纬度实时换算。
 *
 * 由 2:1 白板（W = 2H）可推出一个很舒服的性质：
 *   纬度方向的每像素实距 = 经度方向在赤道处的每像素实距 = k₀ = πR / W
 * 即**像素是正方形**，本文所有换算都只用这一个基准量 k₀。
 */
import type { BoardSpec } from "./types";

/**
 * 赤道处每像素实距的基准量：k₀ = 2πR / W。
 *
 * 推导：白板横向覆盖整圈经度 360°，其长度 = 2πR = W · k₀；
 * 纵向覆盖 180° 纬度，长度 = πR = H · k₀（因 W = 2H，两式等价）；
 * 因此 k₀ = 2πR / W = πR / H —— 两个方向的每像素实距数值相同（像素是正方形）。
 */
const K0_FACTOR = 2 * Math.PI;

/** 极点附近 cos(lat) 的下限，避免除零（对应最大横向拉伸倍数约 100 万） */
const MIN_COS_LAT = 1e-6;

/**
 * 计算基准比例：赤道处每像素对应的公里数（= πR / W）。
 * @param board 白板规格
 * @returns 每像素公里数（km/px）
 */
export function kilometersPerPixelAtEquator(board: BoardSpec): number {
  return (K0_FACTOR * board.radiusKm) / board.width;
}

/**
 * 计算某纬度处「经度方向」的每像素实距（横向）。
 * @param board 白板规格
 * @param lat 纬度（度）
 * @returns 每像素公里数（km/px）
 */
export function kilometersPerPixelLon(board: BoardSpec, lat: number): number {
  return kilometersPerPixelAtEquator(board) * Math.max(Math.cos((lat * Math.PI) / 180), MIN_COS_LAT);
}

/**
 * 计算「纬度方向」的每像素实距（纵向，与纬度无关）。
 * @param board 白板规格
 * @returns 每像素公里数（km/px）
 */
export function kilometersPerPixelLat(board: BoardSpec): number {
  return kilometersPerPixelAtEquator(board);
}

/**
 * 计算某纬度处的横向变形倍率（相对赤道）。
 * 等距圆柱只拉伸横向，因此面积放大倍数与它相同。
 * @param lat 纬度（度）
 * @returns 变形倍率（赤道为 1，北纬 60° 约为 2）
 */
export function deformFactor(lat: number): number {
  return 1 / Math.max(Math.cos((lat * Math.PI) / 180), MIN_COS_LAT);
}

/**
 * 计算白板赤道周长（公里），用于展示「这个世界有多大」。
 * @param board 白板规格
 * @returns 周长（km）
 */
export function equatorCircumferenceKm(board: BoardSpec): number {
  return 2 * Math.PI * board.radiusKm;
}

/**
 * 计算白板经线半圈长度（极到极，公里）。
 * @param board 白板规格
 * @returns 经线半圈长度（km）
 */
export function meridianLengthKm(board: BoardSpec): number {
  return Math.PI * board.radiusKm;
}

/**
 * 像素长度 → 沿经线方向的实际距离（公里）。
 * @param pixels 像素长度
 * @param board 白板规格
 * @returns 实距（km）
 */
export function pixelsToKilometersLat(pixels: number, board: BoardSpec): number {
  return pixels * kilometersPerPixelLat(board);
}

/** 比例尺读数：界面信息条与比例尺条共用 */
export interface ScaleReadout {
  /** 光标纬度（度） */
  lat: number;
  /** 该纬度处横向每像素实距（km/px） */
  lonKmPerPixel: number;
  /** 纵向每像素实距（km/px，与纬度无关） */
  latKmPerPixel: number;
  /** 基准量 k₀（赤道每像素实距，km/px） */
  equatorKmPerPixel: number;
  /** 横向变形倍率 */
  deform: number;
}

/**
 * 汇总某纬度处的完整比例尺读数。
 * @param board 白板规格
 * @param lat 纬度（度）
 * @returns 比例尺读数
 */
export function scaleAt(board: BoardSpec, lat: number): ScaleReadout {
  return {
    lat,
    lonKmPerPixel: kilometersPerPixelLon(board, lat),
    latKmPerPixel: kilometersPerPixelLat(board),
    equatorKmPerPixel: kilometersPerPixelAtEquator(board),
    deform: deformFactor(lat),
  };
}

/**
 * 给出比例尺条应显示的长度（像素）与对应实距（公里）。
 *
 * 规则：实距取「1/2/5 × 10ⁿ」的整数刻度，像素长度 = 实距 / 当前比例尺。
 * 记分取「与目标像素宽度最接近」的刻度，这样放大时像素宽度总体递增
 * （刻度是离散的，因此允许小幅波动，但不会出现「放大后比例尺条明显变短」）。
 *
 * @param board 白板规格
 * @param lat 纬度（度）
 * @param zoom 视图缩放倍数
 * @param targetPixels 期望的像素宽度（默认 120）
 * @returns 像素宽度与实距（km）
 */
export function scaleBar(
  board: BoardSpec,
  lat: number,
  zoom: number,
  targetPixels = 120,
): { pixels: number; kilometers: number } {
  const kmPerPixel = kilometersPerPixelLon(board, lat) / Math.max(zoom, 1e-6);
  const targetKm = kmPerPixel * targetPixels;
  if (!Number.isFinite(targetKm) || targetKm <= 0) {
    return { pixels: targetPixels, kilometers: 0 };
  }

  // 1/2/5 × 10ⁿ 的候选刻度：覆盖 m 级到光年级
  const exponent = Math.floor(Math.log10(targetKm));
  const candidates: number[] = [];
  for (let e = exponent - 1; e <= exponent + 1; e += 1) {
    for (const mantissa of [1, 2, 5]) {
      candidates.push(mantissa * Math.pow(10, e));
    }
  }

  let best = candidates[0] ?? targetKm;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const diff = Math.abs(candidate - targetKm);
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }

  return { pixels: best / kmPerPixel, kilometers: best };
}
