/**
 * 手绘地图的图案定义与装饰散布的**纯逻辑**部分。
 *
 * 为什么把"纯逻辑"单独拆出来：图案绘制必须依赖 Canvas，
 * 但「哪个格子该长装饰、长成什么样」这部分是可以推理与测试的
 * （尤其是**稳定性**——同一格必须永远长同一种装饰，否则画面会闪）。
 *
 * 观感取向（方案 §8）：档案馆 / 编年史 / 中世纪手绘地图，
 * 靠"纸张底色 + 有限色板 + 描边 + 稀疏装饰"营造，而不是靠花哨配色。
 */
import type { TerrainBrush } from "@worldmap/core";

/** 地形的图案类型：决定用哪种平铺纹理 */
export type TerrainPatternKind =
  | "wave" // 海洋 / 浅海：波浪线
  | "dots" // 草地：稀疏点与短斜线
  | "trees" // 森林：小树丛
  | "sand" // 沙漠：细密点阵
  | "peaks" // 山地：小三角折线（chevron）
  | "snow" // 雪地：细十字
  | "hatch"; // 兜底：斜线

/** 一种地形的绘制样式（图案 + 描边色 + 装饰） */
export interface TerrainStyle {
  /** 调色板下标 */
  index: number;
  /** 平铺纹理类型 */
  pattern: TerrainPatternKind;
  /** 地形边界描边色（中世纪手绘感的一半来自这个） */
  stroke: string;
  /** 是否在区域内部散布装饰符号（A+B 里的 B） */
  decoration: DecorationKind | null;
}

/** 装饰符号类型 */
export type DecorationKind = "peak" | "tree" | "wave" | "dune";

/**
 * 装饰符号的画风。
 *
 * - `antique`：手绘古地图（木刻线条，素材来自 Kenney Cartography Pack，CC0）
 * - `modern`：简洁现代手绘（程序化绘制，线条干净、线条细）
 *
 * 两者只影响**装饰符号与图案的画法**，数据层（1 字节/格的调色板下标）完全不变——
 * 所以切换是纯观感操作，不会碰用户的地图内容。
 */
export type SymbolStyle = "antique" | "modern";

/**
 * 古地图风格下，每个装饰类型用哪个素材符号。
 *
 * 素材是一整套无命名的矢量符号，这里的编号是构建期从素材拆解时给的序号
 * （见 `symbols-antique.ts` 的 `sourceIndex`）。
 * ⚠️ 这是**观感参数**：觉得某个地形上的符号不合适，改这里的编号即可。
 */
export const ANTIQUE_DECORATION_SYMBOLS: Record<DecorationKind, number> = {
  peak: 44,
  tree: 40,
  wave: 18,
  dune: 39,
};

/**
 * 默认地形样式表：按调色板下标给出图案与描边。
 *
 * 命名与 `DEFAULT_TERRAIN_PALETTE` 对齐（海洋 / 浅海 / 草地 / 森林 / 沙漠 / 山地 / 雪地）。
 */
export const DEFAULT_TERRAIN_STYLES: TerrainStyle[] = [
  { index: 1, pattern: "wave", stroke: "#16303f", decoration: "wave" },
  { index: 2, pattern: "wave", stroke: "#27506a", decoration: null },
  { index: 3, pattern: "dots", stroke: "#4a6340", decoration: null },
  { index: 4, pattern: "trees", stroke: "#33492f", decoration: "tree" },
  { index: 5, pattern: "sand", stroke: "#a8905f", decoration: "dune" },
  { index: 6, pattern: "peaks", stroke: "#5f5044", decoration: "peak" },
  { index: 7, pattern: "snow", stroke: "#b8c2c8", decoration: null },
];

/**
 * 取某调色板下标的样式；未登记的用斜线兜底。
 * @param terrainIndex 调色板下标
 * @param styles 样式表
 * @returns 对应的样式
 */
export function resolveTerrainStyle(terrainIndex: number, styles = DEFAULT_TERRAIN_STYLES): TerrainStyle {
  return (
    styles.find((style) => style.index === terrainIndex) ?? {
      index: terrainIndex,
      pattern: "hatch",
      stroke: "#5a544a",
      decoration: null,
    }
  );
}

/** 装饰网格的单元边长（世界像素）：装饰密度由它决定 */
export const DECORATION_CELL_PX = 28;

/**
 * 稳定的整数哈希：同样的输入永远得到同样的输出。
 *
 * 装饰必须**确定性**——若用 Math.random()，每帧重绘都会换位置，画面会闪。
 * @param x 整数 x
 * @param y 整数 y
 * @param salt 附加扰动（用于同一格内取多个随机值）
 * @returns [0, 1) 的伪随机数
 */
export function hash2d(x: number, y: number, salt = 0): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + salt * 1442695040888963407;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  // 取低 31 位映射到 [0, 1)
  return ((h >>> 0) % 1000003) / 1000003;
}

/** 一个装饰实例（世界像素坐标） */
export interface DecorationInstance {
  kind: DecorationKind;
  /** 单元内的世界像素位置 */
  x: number;
  y: number;
  /** 尺寸系数（0.7~1.3，让大小有变化但可复现） */
  scale: number;
}

/**
 * 计算某个装饰网格单元内应该画什么装饰。
 *
 * 规则：用哈希决定「这一格有没有装饰」「放在格内哪个位置」「多大」，
 * 因此**同一格永远长同一个装饰**，重绘、缩放、导出都一致。
 *
 * @param cellCol 单元列号
 * @param cellRow 单元行号
 * @param kind 装饰类型
 * @param density 密度（0~1，越大越容易出现装饰）
 * @param cellSize 单元边长（世界像素）
 * @returns 装饰实例；该格为空时返回 null
 */
export function decorationAt(
  cellCol: number,
  cellRow: number,
  kind: DecorationKind,
  density: number,
  cellSize = DECORATION_CELL_PX,
): DecorationInstance | null {
  // 出现概率
  if (hash2d(cellCol, cellRow, 1) > density) {
    return null;
  }
  const offsetX = hash2d(cellCol, cellRow, 2);
  const offsetY = hash2d(cellCol, cellRow, 3);
  const scaleSeed = hash2d(cellCol, cellRow, 4);
  // 边距 15%：避免装饰贴到单元边界而显得拥挤
  const margin = 0.15;
  const usable = 1 - margin * 2;
  return {
    kind,
    x: (cellCol + margin + offsetX * usable) * cellSize,
    y: (cellRow + margin + offsetY * usable) * cellSize,
    scale: 0.7 + scaleSeed * 0.6,
  };
}

/** 视口覆盖的装饰单元范围 */
export interface DecorationRange {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

/**
 * 计算视口内需要绘制的装饰单元范围（含边界外扩一格，避免边缘缺装饰）。
 * @param offsetX 视口左上角世界 x
 * @param offsetY 视口左上角世界 y
 * @param viewWidth 视口宽（世界像素）
 * @param viewHeight 视口高（世界像素）
 * @param boardWidth 白板宽（用于夹取）
 * @param boardHeight 白板高
 * @param cellSize 单元边长
 * @returns 单元行列范围
 */
export function decorationRange(
  offsetX: number,
  offsetY: number,
  viewWidth: number,
  viewHeight: number,
  boardWidth: number,
  boardHeight: number,
  cellSize = DECORATION_CELL_PX,
): DecorationRange {
  const cols = Math.ceil(boardWidth / cellSize);
  const rows = Math.ceil(boardHeight / cellSize);
  return {
    minCol: Math.max(0, Math.floor(offsetX / cellSize) - 1),
    maxCol: Math.min(cols - 1, Math.floor((offsetX + viewWidth) / cellSize) + 1),
    minRow: Math.max(0, Math.floor(offsetY / cellSize) - 1),
    maxRow: Math.min(rows - 1, Math.floor((offsetY + viewHeight) / cellSize) + 1),
  };
}

/**
 * 各种地形在同一区域的默认装饰密度。
 * 海洋稀疏（浪花不能太密），森林与山地较密。
 * @param pattern 图案类型
 * @returns 密度（0~1）
 */
export function decorationDensityFor(pattern: TerrainPatternKind): number {
  switch (pattern) {
    case "wave":
      return 0.25;
    case "trees":
      return 0.5;
    case "peaks":
      return 0.45;
    case "sand":
      return 0.2;
    default:
      return 0;
  }
}
