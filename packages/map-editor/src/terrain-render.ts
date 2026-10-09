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
 *
 * 步骤：先铺纸张底 → 逐地形用图案填充 → 地形边界描边 → 散布装饰。
 * 边界描边与装饰都要求知道邻格，因此这里逐像素扫描一次索引数组。
 *
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
  if (!context) {
    return canvas;
  }

  // ① 纸张底
  const paperPattern = context.createPattern(paper, "repeat");
  context.fillStyle = paperPattern ?? PAPER_BASE;
  context.fillRect(0, 0, width, height);

  // ② 按地形色填充（用图案铺，图案按世界坐标对齐 → 缩放平移时不游动）
  const byIndex = new Map<number, { color: string; ink: string; pattern: TerrainPatternKind }>();
  for (const brush of palette) {
    const style = resolveTerrainStyle(brush.index);
    byIndex.set(brush.index, { color: brush.color, ink: style.stroke, pattern: style.pattern });
  }
  // 同一地形共用一个离屏图案（createPattern 需要元素，缓存起来避免重复生成）
  const patternCache = new Map<number, CanvasPattern | null>();
  const colorCache = new Map<number, string>();

  // 逐行成段扫描：同一行里连续的相同地形取一段，减少 fillRect 次数
  for (let y = 0; y < height; y += 1) {
    let runStart = 0;
    let current = indices[y * width] ?? 0;
    for (let x = 1; x <= width; x += 1) {
      const value = x < width ? (indices[y * width + x] ?? 0) : -1;
      if (value === current) {
        continue;
      }
      // 收束 [runStart, x) 这一段
      if (current !== 0) {
        const info = byIndex.get(current);
        if (info) {
          let pattern = patternCache.get(current);
          if (pattern === undefined) {
            const tile = createTerrainPattern(info.pattern, info.color, info.ink);
            pattern = context.createPattern(tile, "repeat");
            patternCache.set(current, pattern);
          }
          if (pattern) {
            context.fillStyle = pattern;
          } else {
            let color = colorCache.get(current);
            if (!color) {
              color = info.color;
              colorCache.set(current, color);
            }
            context.fillStyle = color;
          }
          context.fillRect(runStart, y, x - runStart, 1);
        }
      }
      runStart = x;
      current = value;
    }
  }

  // ③ 地形边界描边：只描「左右或上下邻格地形不同」的边
  context.lineWidth = 1;
  context.beginPath();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = indices[y * width + x] ?? 0;
      if (value === 0) {
        continue;
      }
      const right = x + 1 < width ? (indices[y * width + x + 1] ?? 0) : 0;
      const below = y + 1 < height ? (indices[(y + 1) * width + x] ?? 0) : 0;
      const style = resolveTerrainStyle(value);
      if (right !== value) {
        context.strokeStyle = style.stroke;
        context.beginPath();
        context.moveTo(x + 1, y);
        context.lineTo(x + 1, y + 1);
        context.stroke();
      }
      if (below !== value) {
        context.strokeStyle = style.stroke;
        context.beginPath();
        context.moveTo(x, y + 1);
        context.lineTo(x + 1, y + 1);
        context.stroke();
      }
    }
  }

  // ④ 装饰散布（A+B 里的 B）：确定性哈希，同一格永远同一种装饰
  drawDecorations(context, indices, width, height);

  return canvas;
}

/**
 * 在整幅图上散布装饰符号。
 * @param context 目标上下文
 * @param indices 索引栅格
 * @param width 宽
 * @param height 高
 */
function drawDecorations(
  context: CanvasRenderingContext2D,
  indices: Uint8Array,
  width: number,
  height: number,
): void {
  const range = decorationRange(0, 0, width, height, width, height, DECORATION_CELL_PX);
  context.lineWidth = 1.2;
  context.lineCap = "round";
  for (let cellRow = range.minRow; cellRow <= range.maxRow; cellRow += 1) {
    for (let cellCol = range.minCol; cellCol <= range.maxCol; cellCol += 1) {
      // 取单元中心的地形，决定这里该长什么
      const cx = Math.min(width - 1, Math.floor((cellCol + 0.5) * DECORATION_CELL_PX));
      const cy = Math.min(height - 1, Math.floor((cellRow + 0.5) * DECORATION_CELL_PX));
      const value = indices[cy * width + cx] ?? 0;
      if (value === 0) {
        continue;
      }
      const style = resolveTerrainStyle(value);
      if (!style.decoration) {
        continue;
      }
      const density = decorationDensityFor(style.pattern);
      const instance = decorationAt(cellCol, cellRow, style.decoration, density, DECORATION_CELL_PX);
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
