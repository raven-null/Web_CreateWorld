/**
 * 把一次落笔换算成像素矩形并写入栅格。
 *
 * 坐标约定（方案 §8）：经纬度是唯一真源，但绘制在平面像素上进行 ——
 * 世界像素 = 归一化坐标 × 白板尺寸；屏幕像素 = 世界像素 × zoom - 偏移。
 *
 * **笔刷大小以屏幕像素定义**：手感符合直觉（放大后同一笔刷覆盖更少的真实区域，
 * 便于精修），且与白板分辨率解耦（换分辨率不用重设笔刷）。
 */
import type { PixelRect } from "./tile-store";

/** 工具类型：measure 是测量工具（只读数、不落笔） */
export type ToolKind = "brush" | "eraser" | "picker" | "pan" | "measure";

/** 笔刷设置 */
export interface BrushSettings {
  /** 地形调色板下标（1~255，0 表示透明） */
  terrainIndex: number;
  /** 笔刷边长（屏幕像素） */
  screenSize: number;
  tool: ToolKind;
}
/** 笔刷默认设置 */
export const DEFAULT_BRUSH: BrushSettings = {
  terrainIndex: 1,
  screenSize: 24,
  tool: "brush",
};

/** 笔刷屏幕尺寸范围（方案 §7.3：必须支持到 1 像素，满足极精细绘制） */
export const MIN_BRUSH_SCREEN_SIZE = 1;
export const MAX_BRUSH_SCREEN_SIZE = 64;

/**
 * 计算笔刷在世界像素下的边长。
 * @param screenSize 屏幕像素边长
 * @param zoom 视图缩放
 * @returns 世界像素边长（至少 1）
 */
export function brushWorldSize(screenSize: number, zoom: number): number {
  return Math.max(1, screenSize / Math.max(zoom, 1e-6));
}

/**
 * 计算以某点为中心的方形笔刷覆盖的像素矩形（已夹在白板范围内）。
 * @param centerX 中心点世界像素 x
 * @param centerY 中心点世界像素 y
 * @param screenSize 笔刷屏幕像素边长
 * @param zoom 视图缩放
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @returns 像素矩形；完全在画布外时返回 null
 */
export function brushRect(
  centerX: number,
  centerY: number,
  screenSize: number,
  zoom: number,
  boardWidth: number,
  boardHeight: number,
): PixelRect | null {
  const size = Math.round(brushWorldSize(screenSize, zoom));
  const half = Math.floor(size / 2);
  const startX = Math.floor(centerX) - half;
  const startY = Math.floor(centerY) - half;
  const endX = startX + size;
  const endY = startY + size;

  const x = Math.max(0, startX);
  const y = Math.max(0, startY);
  const right = Math.min(boardWidth, endX);
  const bottom = Math.min(boardHeight, endY);
  if (right <= x || bottom <= y) {
    return null;
  }
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 把笔刷涂到栅格上。
 *
 * 直白的逐像素写入：世界像素与本机内存一一对应，不做插值。
 * @param indices 全幅栅格（就地修改）
 * @param boardWidth 白板宽
 * @param rect 覆盖矩形
 * @param terrainIndex 写入的调色板下标（0 表示擦除成透明）
 */
export function paintRect(indices: Uint8Array, boardWidth: number, rect: PixelRect, terrainIndex: number): void {
  const value = terrainIndex & 0xff;
  for (let row = 0; row < rect.height; row += 1) {
    const start = (rect.y + row) * boardWidth + rect.x;
    indices.fill(value, start, start + rect.width);
  }
}

/**
 * 合并两个像素矩形（用于把一次笔画的所有落点归成一个撤销单元）。
 * @param a 矩形 A；为 null 时返回 B
 * @param b 矩形 B
 * @returns 合并后的外接矩形
 */
export function unionRect(a: PixelRect | null, b: PixelRect): PixelRect {
  if (!a) {
    return { ...b };
  }
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 把矩形向外扩边（撤销恢复时宁大勿小，避免边缘残留）。
 * @param rect 矩形
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @param margin 外扩像素数
 * @returns 外扩后的矩形
 */
export function expandRect(rect: PixelRect, boardWidth: number, boardHeight: number, margin = 1): PixelRect {
  const x = Math.max(0, rect.x - margin);
  const y = Math.max(0, rect.y - margin);
  const right = Math.min(boardWidth, rect.x + rect.width + margin);
  const bottom = Math.min(boardHeight, rect.y + rect.height + margin);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * 把笔刷大小限制在允许范围。
 * @param size 输入值
 * @returns 限制后的值
 */
export function clampBrushSize(size: number): number {
  return Math.min(MAX_BRUSH_SCREEN_SIZE, Math.max(MIN_BRUSH_SCREEN_SIZE, Math.round(size)));
}

/**
 * 判断某个调色板下标是否为「擦除」（透明）。
 * @param terrainIndex 调色板下标
 * @returns 透明返回 true
 */
export function isEraseIndex(terrainIndex: number): boolean {
  return terrainIndex === 0;
}

/**
 * 在两点之间按步长采样，补齐快速拖动时漏掉的落点。
 *
 * 指针事件是离散的：快速划一笔时相邻事件的间距可能是笔刷的好几倍，
 * 中间不补点就会画成断续的虚线。步长取笔刷世界尺寸的一半——
 * 既保证笔画连贯，又不会因为点数过多而拖慢绘制。
 *
 * @param from 起点（屏幕坐标）
 * @param to 终点（屏幕坐标）
 * @param stepPixels 采样步长（屏幕像素）
 * @returns 中间采样点（不含起点，含终点）；两点重合时返回空数组
 */
export function interpolatePointerPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  stepPixels: number,
): { x: number; y: number }[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const step = Math.max(1, stepPixels);
  if (distance <= step) {
    return [{ x: to.x, y: to.y }];
  }
  const count = Math.ceil(distance / step);
  const points: { x: number; y: number }[] = [];
  for (let i = 1; i <= count; i += 1) {
    const t = i / count;
    points.push({ x: from.x + dx * t, y: from.y + dy * t });
  }
  return points;
}
