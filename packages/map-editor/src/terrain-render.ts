/**
 * 手绘图案与纸张质感的渲染层（方案 §8 的观感取向：档案馆 / 中世�手绘地图）。
 *
 * 三条关键设计：
 * 1. **图案不进数据**：数据层只有 1 字节/格的调色板下标；纹理、描边、装饰
 *    全部是渲染时的产物。否则用户一涂改就会把纹理弄花，调色板也装不下。
 * 2. **纹理按世界坐标固定**：同一个地形格永远长同一个图案，缩放平移时不会「游动」。
 * 3. **纹理层整幅缓存**：把图案烘到一张离屏画布上，绘制时只做一次 drawImage；
 *    代价是编辑后需要重烘（一笔一次，可接受），换来的是涂抹时的帧率。
 */
import type { TerrainBrush } from "@worldmap/core";
import {
  DECORATION_CELL_PX,
  decorationAt,
  decorationDensityFor,
  decorationRange,
  resolveTerrainStyle,
  type TerrainPatternKind,
} from "./terrain-style";

/** 图案格边长（屏幕像素）：纹理在屏幕上的粒度，与缩放无关 */
const PATTERN_CELL_PX = 32;

/**
 * 纸张底色：**暗纸**（比界面底色略暖一点）。
 *
 * 取舍过程：编辑器整体是深色（墨色 / 暗棕）界面。最初把纸张做成亮米色，
 * 结果"底色亮 + 界面文字浅"两边都看不清——纸的质感应当来自**纹理与装饰**，
 * 而不是靠亮底色。因此纸张取暗暖色：与深色 UI 和谐，
 * 地形色（海洋的深蓝、草地的绿、雪地的白）在它上面反而更清楚。
 */
export const PAPER_BASE = "#241f18";
/** 噪点与污渍强度（暗底上要略强一点才看得出纸的质感） */
const PAPER_NOISE_ALPHA = 0.07;

/** 渲染模式 */
export type RenderStyleMode = "flat" | "handdrawn";

/**
 * 生成纸张质感贴图（米色底 + 细噪点 + 轻微污渍）。
 *
 * 尺寸取 256×256 并平铺：噪点是均匀随机的，平铺不会看出接缝，
 * 但比整幅绘制省内存也省时间。
 *
 * @param size 贴图边长
 * @returns 贴图画布
 */
export function createPaperTexture(size = 256): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) {
    return canvas;
  }
  context.fillStyle = PAPER_BASE;
  context.fillRect(0, 0, size, size);

  // 细噪点：模仿纸张纤维（暗底上用偏亮的纤维，才看得出纹路）
  for (let i = 0; i < size * size * 0.12; i += 1) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const light = Math.random() > 0.5;
    context.fillStyle = light
      ? `rgba(214, 196, 158, ${PAPER_NOISE_ALPHA})`
      : `rgba(12, 10, 8, ${PAPER_NOISE_ALPHA})`;
    context.fillRect(x, y, 1, 1);
  }

  // 淡淡的污渍 / 折痕：几块柔和的椭圆（暗底上用偏亮的晕染）
  for (let i = 0; i < 6; i += 1) {
    const cx = Math.random() * size;
    const cy = Math.random() * size;
    const radius = 20 + Math.random() * 50;
    const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, "rgba(196, 172, 124, 0.05)");
    gradient.addColorStop(1, "rgba(196, 172, 124, 0)");
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fill();
  }
  return canvas;
}

/**
 * 生成某种地形的平铺图案。
 * @param kind 图案类型
 * @param color 地形基色
 * @param ink 图案墨色（描边色）
 * @param cell 图案边长
 * @returns 图案画布
 */
export function createTerrainPattern(
  kind: TerrainPatternKind,
  color: string,
  ink: string,
  cell = PATTERN_CELL_PX,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = cell;
  canvas.height = cell;
  const context = canvas.getContext("2d");
  if (!context) {
    return canvas;
  }
  context.fillStyle = color;
  context.fillRect(0, 0, cell, cell);
  context.strokeStyle = ink;
  context.fillStyle = ink;

  switch (kind) {
    case "wave":
      drawWaves(context, cell);
      break;
    case "dots":
      drawDots(context, cell);
      break;
    case "trees":
      drawTreeMarks(context, cell);
      break;
    case "sand":
      drawSand(context, cell);
      break;
    case "peaks":
      drawPeaks(context, cell);
      break;
    case "snow":
      drawSnow(context, cell);
      break;
    default:
      drawHatch(context, cell);
      break;
  }
  return canvas;
}

/** 海洋：横向波浪线（两行，错开半格） */
function drawWaves(context: CanvasRenderingContext2D, cell: number): void {
  context.lineWidth = 1.2;
  const rowHeight = cell / 4;
  for (let row = 0; row < 4; row += 1) {
    const y = row * rowHeight + rowHeight / 2;
    const offset = row % 2 === 0 ? 0 : cell / 2;
    context.beginPath();
    for (let x = -cell; x < cell * 2; x += cell) {
      context.moveTo(x + offset, y);
      context.quadraticCurveTo(x + offset + cell / 4, y - rowHeight * 0.35, x + offset + cell / 2, y);
      context.quadraticCurveTo(x + offset + (cell * 3) / 4, y + rowHeight * 0.35, x + offset + cell, y);
    }
    context.stroke();
  }
}

/** 草地：稀疏小点 + 短斜线 */
function drawDots(context: CanvasRenderingContext2D, cell: number): void {
  context.lineWidth = 1;
  for (let i = 0; i < 18; i += 1) {
    const x = (i * 37) % cell;
    const y = (i * 61) % cell;
    context.beginPath();
    context.arc(x, y, 0.9, 0, Math.PI * 2);
    context.fill();
  }
  // 短斜线代表草叶
  for (let i = 0; i < 6; i += 1) {
    const x = (i * 53) % cell;
    const y = (i * 29) % cell;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + 2, y - 4);
    context.stroke();
  }
}

/** 森林：小树符号（三角树冠 + 短干） */
function drawTreeMarks(context: CanvasRenderingContext2D, cell: number): void {
  context.lineWidth = 1;
  const positions = [
    { x: cell * 0.25, y: cell * 0.3 },
    { x: cell * 0.7, y: cell * 0.25 },
    { x: cell * 0.45, y: cell * 0.72 },
    { x: cell * 0.85, y: cell * 0.65 },
  ];
  for (const point of positions) {
    const { x, y } = point;
    const size = cell * 0.12;
    context.beginPath();
    context.moveTo(x, y - size);
    context.lineTo(x - size * 0.8, y + size * 0.4);
    context.lineTo(x + size * 0.8, y + size * 0.4);
    context.closePath();
    context.stroke();
    context.beginPath();
    context.moveTo(x, y + size * 0.4);
    context.lineTo(x, y + size * 0.9);
    context.stroke();
  }
}

/** 沙漠：细密点阵 */
function drawSand(context: CanvasRenderingContext2D, cell: number): void {
  for (let i = 0; i < 40; i += 1) {
    const x = (i * 17) % cell;
    const y = (i * 41) % cell;
    context.beginPath();
    context.arc(x, y, 0.7, 0, Math.PI * 2);
    context.fill();
  }
}

/** 山地：小三角折线（chevron） */
function drawPeaks(context: CanvasRenderingContext2D, cell: number): void {
  context.lineWidth = 1.3;
  const rows = 3;
  for (let row = 0; row < rows; row += 1) {
    const y = (row + 1) * (cell / (rows + 1));
    const offset = row % 2 === 0 ? 0 : cell / 4;
    context.beginPath();
    for (let x = -cell; x < cell * 2; x += cell / 2) {
      context.moveTo(x + offset, y);
      context.lineTo(x + offset + cell / 4, y - cell / 6);
      context.lineTo(x + offset + cell / 2, y);
    }
    context.stroke();
  }
}

/** 雪地：细十字 + 大面积留白 */
function drawSnow(context: CanvasRenderingContext2D, cell: number): void {
  context.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const x = (i * 67) % cell;
    const y = (i * 43) % cell;
    const arm = 2.4;
    context.beginPath();
    context.moveTo(x - arm, y);
    context.lineTo(x + arm, y);
    context.moveTo(x, y - arm);
    context.lineTo(x, y + arm);
    context.stroke();
  }
}

/** 兜底：斜线 */
function drawHatch(context: CanvasRenderingContext2D, cell: number): void {
  context.lineWidth = 1;
  for (let i = -cell; i < cell * 2; i += 8) {
    context.beginPath();
    context.moveTo(i, 0);
    context.lineTo(i + cell, cell);
    context.stroke();
  }
}

/**
 * 把整幅索引栅格「烘」成一张手绘风格位图。
 * @param indices 全幅索引栅格
 * @param width 白板宽
 * @param height 白板高
 * @param palette 调色板
 * @param paper 纸张贴图
 * @returns 手绘风格位图
 */
export function bakeHandDrawnLayer(
  indices: Uint8Array,
  width: number,
  height: number,
  palette: TerrainBrush[],
  paper: HTMLCanvasElement,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) {
    bakeRegionInto(context, indices, width, height, { x: 0, y: 0, width, height }, palette, paper);
  }
  return canvas;
}

/** 世界像素矩形（渲染层自用，与 tile-store 的 PixelRect 同构） */
interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把索引栅格的**指定区域**烘进已有画布。
 *
 * 局部重烘是撤销 / 重做的性能关键：整幅重烘一张 2048 宽的手绘位图要几百毫秒，
 * 而一笔通常只覆盖很小一块。
 *
 * @param context 目标上下文（已对应到画布坐标系）
 * @param indices 全幅索引栅格
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @param region 要重烘的区域
 * @param palette 调色板
 * @param paper 纸张贴图
 */
export function bakeRegionInto(
  context: CanvasRenderingContext2D,
  indices: Uint8Array,
  boardWidth: number,
  boardHeight: number,
  region: Region,
  palette: TerrainBrush[],
  paper: HTMLCanvasElement,
): void {
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(boardWidth, Math.ceil(region.x + region.width));
  const bottom = Math.min(boardHeight, Math.ceil(region.y + region.height));
  const runWidth = right - left;
  if (runWidth <= 0 || bottom - top <= 0) {
    return;
  }

  context.save();
  // 局部重烘时把坐标系移到区域左上角，绘制代码就能一直用「区域内的相对坐标」
  context.translate(-left, -top);
  context.beginPath();
  context.rect(left, top, runWidth, bottom - top);
  context.clip();

  // ① 纸张底
  const paperPattern = context.createPattern(paper, "repeat");
  context.fillStyle = paperPattern ?? PAPER_BASE;
  context.fillRect(left, top, runWidth, bottom - top);

  // ② 按地形图案填充：逐行成段扫描，减少 fillRect 次数
  const patternCache = new Map<number, CanvasPattern | null>();
  for (let y = top; y < bottom; y += 1) {
    const rowStart = y * boardWidth;
    let runStart = left;
    let current = indices[rowStart + left] ?? 0;
    for (let x = left + 1; x <= right; x += 1) {
      const value = x < right ? (indices[rowStart + x] ?? 0) : -1;
      if (value === current) {
        continue;
      }
      if (current !== 0) {
        const brush = palette.find((item) => item.index === current);
        const style = resolveTerrainStyle(current);
        let pattern = patternCache.get(current);
        if (pattern === undefined) {
          const tile = createTerrainPattern(style.pattern, brush?.color ?? "#6b6355", style.stroke);
          pattern = context.createPattern(tile, "repeat");
          patternCache.set(current, pattern);
        }
        context.fillStyle = pattern ?? brush?.color ?? "#6b6355";
        context.fillRect(runStart, y, x - runStart, 1);
      }
      runStart = x;
      current = value;
    }
  }

  // ③ 地形边界描边：只描「左右或上下邻格地形不同」的边
  context.lineWidth = 1;
  for (let y = top; y < bottom; y += 1) {
    const rowStart = y * boardWidth;
    for (let x = left; x < right; x += 1) {
      const value = indices[rowStart + x] ?? 0;
      if (value === 0) {
        continue;
      }
      const style = resolveTerrainStyle(value);
      const nextRight = x + 1 < boardWidth ? (indices[rowStart + x + 1] ?? 0) : 0;
      const nextBelow = y + 1 < boardHeight ? (indices[rowStart + boardWidth + x] ?? 0) : 0;
      context.strokeStyle = style.stroke;
      if (nextRight !== value) {
        context.beginPath();
        context.moveTo(x + 1, y);
        context.lineTo(x + 1, y + 1);
        context.stroke();
      }
      if (nextBelow !== value) {
        context.beginPath();
        context.moveTo(x, y + 1);
        context.lineTo(x + 1, y + 1);
        context.stroke();
      }
    }
  }

  // ④ 装饰散布（确定性哈希：同一格永远同一种装饰）
  drawDecorations(context, indices, boardWidth, boardHeight, left, top, right, bottom);
  context.restore();
}

/**
 * 在指定区域内散布装饰符号。
 * @param context 目标上下文
 * @param indices 索引栅格
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @param left 区域左
 * @param top 区域上
 * @param right 区域右
 * @param bottom 区域下
 */
function drawDecorations(
  context: CanvasRenderingContext2D,
  indices: Uint8Array,
  boardWidth: number,
  boardHeight: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): void {
  // 装饰按世界坐标的固定网格生成：即使只重烘一小块，位置也与整幅一致
  const range = decorationRange(left, top, right - left, bottom - top, boardWidth, boardHeight, DECORATION_CELL_PX);
  context.lineWidth = 1.2;
  context.lineCap = "round";
  for (let cellRow = range.minRow; cellRow <= range.maxRow; cellRow += 1) {
    for (let cellCol = range.minCol; cellCol <= range.maxCol; cellCol += 1) {
      const cx = Math.min(boardWidth - 1, Math.floor((cellCol + 0.5) * DECORATION_CELL_PX));
      const cy = Math.min(boardHeight - 1, Math.floor((cellRow + 0.5) * DECORATION_CELL_PX));
      const value = indices[cy * boardWidth + cx] ?? 0;
      if (value === 0) {
        continue;
      }
      const style = resolveTerrainStyle(value);
      if (!style.decoration) {
        continue;
      }
      const instance = decorationAt(
        cellCol,
        cellRow,
        style.decoration,
        decorationDensityFor(style.pattern),
        DECORATION_CELL_PX,
      );
      if (!instance) {
        continue;
      }
      drawDecoration(context, instance.kind, instance.x, instance.y, instance.scale, style.stroke);
    }
  }
}

/**
 * 画一个装饰符号。
 * @param context 目标上下文
 * @param kind 符号类型
 * @param x 世界 x
 * @param y 世界 y
 * @param scale 尺寸系数
 * @param ink 墨色
 */
export function drawDecoration(
  context: CanvasRenderingContext2D,
  kind: "peak" | "tree" | "wave" | "dune",
  x: number,
  y: number,
  scale: number,
  ink: string,
): void {
  const size = 7 * scale;
  context.strokeStyle = ink;
  context.beginPath();
  switch (kind) {
    case "peak": {
      // 双尖山：一个主峰 + 一个侧峰，带一点雪线
      context.moveTo(x - size, y + size * 0.6);
      context.lineTo(x, y - size * 0.7);
      context.lineTo(x + size, y + size * 0.6);
      context.moveTo(x + size * 0.2, y + size * 0.1);
      context.lineTo(x + size * 0.7, y - size * 0.3);
      context.lineTo(x + size * 1.2, y + size * 0.6);
      context.stroke();
      break;
    }
    case "tree": {
      // 小树：树冠 + 短干
      context.moveTo(x, y - size * 0.6);
      context.lineTo(x - size * 0.5, y + size * 0.2);
      context.lineTo(x + size * 0.5, y + size * 0.2);
      context.closePath();
      context.moveTo(x, y + size * 0.2);
      context.lineTo(x, y + size * 0.6);
      context.stroke();
      break;
    }
    case "wave": {
      // 浪花：两条短弧
      context.moveTo(x - size * 0.8, y);
      context.quadraticCurveTo(x - size * 0.4, y - size * 0.4, x, y);
      context.quadraticCurveTo(x + size * 0.4, y + size * 0.4, x + size * 0.8, y);
      context.moveTo(x - size * 0.5, y + size * 0.5);
      context.quadraticCurveTo(x - size * 0.1, y + size * 0.1, x + size * 0.3, y + size * 0.5);
      context.stroke();
      break;
    }
    case "dune": {
      // 沙丘：一长一短两段弧
      context.moveTo(x - size, y + size * 0.4);
      context.quadraticCurveTo(x - size * 0.2, y - size * 0.5, x + size * 0.6, y + size * 0.2);
      context.moveTo(x - size * 0.6, y + size * 0.8);
      context.quadraticCurveTo(x, y + size * 0.2, x + size * 0.8, y + size * 0.7);
      context.stroke();
      break;
    }
    default:
      break;
  }
}
