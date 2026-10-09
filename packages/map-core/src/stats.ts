/**
 * 地图编辑器核心的尺度统计类型（§7.6）。
 * 统计由保存流程增量维护，绝不扫描全图。
 */

/** 已画内容的尺度统计 */
export interface MapScaleStats {
  /** 栅格图层像素计数：layerId → 调色板下标 → 像素数 */
  rasterByLayer: Record<string, Record<number, number>>;
  /** 矢量图层的球面面积（km²），按图层汇总 */
  vectorAreaByLayer: Record<string, number>;
  /** 统计更新时间戳 */
  updatedAt: number;
}
