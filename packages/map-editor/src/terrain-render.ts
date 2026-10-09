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
 *
 * 宿主可以提供真实的纸张素材（`paperTextureUrl`）替换它，见 `applyPaperTexture()`。
 */
export const PAPER_BASE = "#241f18";
/** 噪点与污渍强度（暗底上要略强一点才看得出纸的质感） */
const PAPER_NOISE_ALPHA = 0.07;

/** 外部纸张贴图的默认边长：512 既够细，显存占用也可控（整幅白板只有它一份） */
export const PAPER_TILE_SIZE = 512;

/**
 * 纸张铺法。
 *
 * - `tile`：平铺。适合**图案型**素材（花纹、织物、可无缝重复的纹理）
 * - `stretch`：整幅拉伸铺一张。适合**照片型**素材（一张完整的羊皮纸 / 老纸照片）——
 *   没有重复感，是这张图最自然的用法
 */
export type PaperFill = "tile" | "stretch";

/** 当前铺法（默认平铺：程序化生成的纸张本来就是可平铺的噪点） */
let paperFill: PaperFill = "tile";

/** 当前生效的拉伸纸张（铺法为 stretch 时用；按白板比例裁好，只画一次） */
let paperStretch: HTMLCanvasElement | null = null;

/** 拉伸铺法用的源图（已解码） */
let paperStretchSource: HTMLImageElement | null = null;

/** 当前生效的纸张贴图（铺法为 tile 时用；null 表示还没人设置，按需生成程序化版本） */
let paperTexture: HTMLCanvasElement | null = null;

/** 纸张代表色缓存（贴图换了要清掉） */
let paperBaseCache: string | null = null;

/** 渲染模式 */
export type RenderStyleMode = "flat" | "handdrawn";

/**
 * 生成纸张质感贴图（暗底 + 细噪点 + 轻微污渍）。
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
 * 取当前纸张贴图（惰性生成：没设置过外部素材时用程序化版本）。
 * @returns 纸张贴图画布
 */
export function currentPaperTexture(): HTMLCanvasElement {
  if (!paperTexture) {
    paperTexture = createPaperTexture();
  }
  return paperTexture;
}

/**
 * 把一张图片做成**四边无缝**的平铺贴图。
 *
 * 为什么不能直接平铺：素材通常是一张普通照片 / 纹理图，四边颜色对不上，
 * 平铺后会出现明显的网格接缝（地图上一眼就能看出格线）。
 * 做法是「镜像拼贴」——把 2×2 拼块里右半与下半取镜像，
 * 于是拼块四条边两侧的颜色天然一致，接缝消失；代价是出现镜像对称，
 * 对羊皮纸这类有机纹理几乎看不出重复。
 *
 * @param source 已解码完成的图片（HTMLImageElement / ImageBitmap 均可）
 * @param size 输出边长
 * @returns 可无缝平铺的画布
 */
export function createSeamlessTile(
  source: CanvasImageSource & { width: number; height: number },
  size = PAPER_TILE_SIZE,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) {
    return canvas;
  }

  // 源图先按「居中正方形」取景，再缩放；否则宽高比不同会把纹理拉变形
  const side = Math.min(source.width, source.height);
  const sx = (source.width - side) / 2;
  const sy = (source.height - side) / 2;

  // 四象限镜像：每块都是同一份正方形区域的翻转版本
  const half = size / 2;
  const draw = (dx: number, dy: number, flipX: boolean, flipY: boolean): void => {
    context.save();
    context.translate(dx + (flipX ? half : 0), dy + (flipY ? half : 0));
    context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    context.drawImage(source, sx, sy, side, side, 0, 0, half, half);
    context.restore();
  };
  draw(0, 0, false, false);
  draw(half, 0, true, false);
  draw(0, half, false, true);
  draw(half, half, true, true);
  return canvas;
}

/**
 * 计算整幅纸张的取景规则。
 *
 * **取整张，不裁切也不留边**：直接让素材铺满白板矩形。
 * 取舍过程：一开始按比例居中裁切（避免宽高比差异造成变形），
 * 但羊皮纸那张是 4:3、白板是 2:1，按比例裁会丢掉 1/3 的画面——
 * 而纸张是**有机纹理**，轻微拉伸看不出来，丢画面却看得出来。
 * 因此选择「整张铺满、微变形」：素材细节一点不浪费。
 *
 * ⚠️ 素材分辨率别低于白板的一半，否则放大后会糊（羊皮纸 1440 宽 → 白板 2048 只用放大 1.42 倍）。
 *
 * @param sourceWidth 源图宽
 * @param sourceHeight 源图高
 * @returns 源图上要取的区域（整张）
 */
export function resolveStretchCrop(
  sourceWidth: number,
  sourceHeight: number,
): { sx: number; sy: number; sw: number; sh: number } {
  return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight };
}

/**
 * 计算「目标区域」需要从整幅纸张里取哪一块（坐标都是世界像素）。
 *
 * 局部重烘时目标上下文被平移到区域原点，所以世界坐标必须减掉区域原点，
 * 否则图案会整体位移——这是最容易写错、也最难肉眼定位的一处。
 *
 * @param left 区域左上角的世界 x
 * @param top 区域左上角的世界 y
 * @param width 区域宽
 * @param height 区域高
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @param stretchWidth 整幅纸张的宽
 * @param stretchHeight 整幅纸张的高
 * @returns 源图取样矩形 + 目标绘制矩形
 */
export function resolvePaperStretchDraw(
  left: number,
  top: number,
  width: number,
  height: number,
  boardWidth: number,
  boardHeight: number,
  stretchWidth: number,
  stretchHeight: number,
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  return {
    sx: (left / boardWidth) * stretchWidth,
    sy: (top / boardHeight) * stretchHeight,
    sw: (width / boardWidth) * stretchWidth,
    sh: (height / boardHeight) * stretchHeight,
    dx: 0,
    dy: 0,
    dw: width,
    dh: height,
  };
}

/**
 * 把一张图片做成**按白板比例裁好的整幅底图**（铺法 `stretch` 用）。
 *
 * @param source 已解码完成的图片
 * @param width 输出宽（白板宽）
 * @param height 输出高（白板高）
 * @returns 整幅底图画布
 */
export function createStretchFill(
  source: CanvasImageSource & { width: number; height: number },
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) {
    return canvas;
  }
  const { sx, sy, sw, sh } = resolveStretchCrop(source.width, source.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * 把整幅纸张的一个区域画到目标上下文。
 *
 * 只画白板覆盖到的那一段：局部重烘时目标矩形可能只是白板的一小块，
 * 按比例取源图的对应区域即可，不必每次都画整张。
 *
 * @param context 目标上下文（调用方已经把坐标系移到区域左上角）
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @param worldLeft 区域左上角的世界 x
 * @param worldTop 区域左上角的世界 y
 * @param width 区域宽
 * @param height 区域高
 * @param stretch 裁好的整幅底图
 * @param localX 区域在目标上下文里的左上角 x（= 世界 x − 区域世界原点）
 * @param localY 区域在目标上下文里的左上角 y
 */
function drawPaperStretch(
  context: CanvasRenderingContext2D,
  boardWidth: number,
  boardHeight: number,
  worldLeft: number,
  worldTop: number,
  width: number,
  height: number,
  stretch: HTMLCanvasElement,
  localX: number,
  localY: number,
): void {
  const rect = resolvePaperStretchDraw(
    worldLeft,
    worldTop,
    width,
    height,
    boardWidth,
    boardHeight,
    stretch.width,
    stretch.height,
  );
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(stretch, rect.sx, rect.sy, rect.sw, rect.sh, localX, localY, width, height);
}

/**
 * 把纸张铺到指定区域（按当前铺法分派）。
 *
 * 两个调用方（整幅烘焙、局部重烘）都走这里，
 * 避免「整幅用拉伸、局部用平铺」这种两处不一致的坑。
 *
 * @param context 目标上下文（坐标系已移到区域左上角）
 * @param left 区域左
 * @param top 区域上
 * @param width 区域宽
 * @param height 区域高
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @param offsetX 区域左上角在世界坐标里的 x（把局部坐标换算回世界坐标用）
 * @param offsetY 区域左上角在世界坐标里的 y
 */
export function fillPaperRegion(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  boardWidth: number,
  boardHeight: number,
  offsetX = 0,
  offsetY = 0,
): void {
  if (paperFill === "stretch") {
    const stretch = ensureStretchPaper(boardWidth, boardHeight);
    if (stretch) {
      // 局部重烘时坐标系已经被移到区域左上角，世界坐标要减掉这个原点；
      // 不减就会出现「图案整体位移」的错位
      drawPaperStretch(
        context,
        boardWidth,
        boardHeight,
        left + offsetX,
        top + offsetY,
        width,
        height,
        stretch,
        left - offsetX,
        top - offsetY,
      );
      return;
    }
    // 没设置过拉伸素材（理论上不会走到）：退回平铺，至少不是空白
  }
  const pattern = context.createPattern(currentPaperTexture(), "repeat");
  if (!pattern) {
    context.fillStyle = PAPER_BASE;
    context.fillRect(left - offsetX, top - offsetY, width, height);
    return;
  }
  // 图案相位对齐到**白板原点**：否则局部重烘出来的纹路与整幅烘焙对不上（错位）
  context.save();
  context.translate(offsetX, offsetY);
  context.fillStyle = pattern;
  context.fillRect(left, top, width, height);
  context.restore();
}

/**
 * 取（或按当前素材现场生成）整幅拉伸底图。
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @returns 整幅底图；没有拉伸素材时返回 null
 */
function ensureStretchPaper(boardWidth: number, boardHeight: number): HTMLCanvasElement | null {
  if (!paperStretchSource) {
    return null;
  }
  const width = Math.max(1, Math.round(boardWidth));
  const height = Math.max(1, Math.round(boardHeight));
  if (!paperStretch || paperStretch.width !== width || paperStretch.height !== height) {
    paperStretch = createStretchFill(paperStretchSource, width, height);
  }
  return paperStretch;
}

/**
 * 当前纸张铺法。
 * @returns `tile` 或 `stretch`
 */
export function currentPaperFill(): PaperFill {
  return paperFill;
}

/**
 * 加载宿主提供的纸张素材并设为当前贴图。
 *
 * 失败（地址无效、格式不支持、图片损坏）时**保留原贴图**并返回 null：
 * 纸张只是观感，不能因为一张图挂了就让编辑器白屏。
 *
 * @param url 图片地址（由宿主的资源管线产出）
 * @param fill 铺法：`tile` 平铺（图案型素材）或 `stretch` 整幅拉伸（照片型素材）
 * @param size 平铺单元边长（仅 `tile` 用）
 * @returns 加载成功返回纸张位图；失败返回 null
 */
export async function applyPaperTexture(
  url: string,
  fill: PaperFill = "tile",
  size = PAPER_TILE_SIZE,
): Promise<PaperBitmap | null> {
  try {
    const image = await loadImage(url);
    paperFill = fill;
    paperBaseCache = null; // 代表色随贴图失效
    if (fill === "stretch") {
      paperStretchSource = image;
      paperStretch = null; // 按需重建：白板尺寸可能变化
      return image;
    }
    paperStretchSource = null;
    paperStretch = null;
    const tile = createSeamlessTile(image, size);
    paperTexture = tile;
    return tile;
  } catch {
    return null;
  }
}

/** 纸张位图：加载后可能是画布（平铺贴图）或图片（整幅拉伸的源图） */
export type PaperBitmap = HTMLCanvasElement | HTMLImageElement;

/**
 * 取用于「采样代表色 / 明暗」的**画布**。
 *
 * 平铺直接给贴图；拉伸给源图（图片本身没有 `getContext`，
 * 因此这里现场缩成一张小画布来采样——源图就能代表整幅，
 * 不必等白板尺寸确定，UI 挂载早期也能取到值）。
 *
 * @returns 采样用画布
 */
function paperSampleCanvas(): HTMLCanvasElement {
  if (paperFill === "stretch" && paperStretchSource) {
    return shrinkToSampleCanvas(paperStretchSource);
  }
  return currentPaperTexture();
}

/**
 * 把任意图片缩成 64×64 的采样画布（避免为了取平均色而读整张大图）。
 * @param source 源位图
 * @returns 采样画布
 */
function shrinkToSampleCanvas(source: PaperBitmap): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    context.drawImage(source, 0, 0, 64, 64);
  }
  return canvas;
}

/**
 * 取纸张的代表色（整张贴图的平均色）。
 *
 * 用途：手绘模式下白板之外的画布区域、以及导出图片的留白，都要用纸张色兜底，
 * 否则换了浅色素材（羊皮纸）后四周会留一圈深色，看着像画面被裁掉了一块。
 * 用平均色而不是底色常量，是为了「宿主换了纸张，兜底色也跟着换」。
 *
 * @returns CSS 颜色字符串
 */
export function paperBaseColor(): string {
  if (paperBaseCache) {
    return paperBaseCache;
  }
  const tile = paperSampleCanvas();
  const context = tile.getContext("2d");
  if (!context || tile.width === 0 || tile.height === 0) {
    return PAPER_BASE;
  }
  const { data } = context.getImageData(0, 0, tile.width, tile.height);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 64) {
    r += data[i] ?? 0;
    g += data[i + 1] ?? 0;
    b += data[i + 2] ?? 0;
    count += 1;
  }
  if (count === 0) {
    return PAPER_BASE;
  }
  paperBaseCache = `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
  return paperBaseCache;
}

/**
 * 判断纸张是不是「亮纸」。
 *
 * 用途：画布上的比例尺、测量读数要按纸张明暗反着配色——
 * 亮纸（如羊皮纸）配深色文字、暗纸配浅色文字。
 * 曾把亮纸配浅色文字，结果"背景亮 + 字体浅"，根本看不清。
 *
 * @returns 平均亮度 > 0.62 时返回 true（阈值取「浅米色」一侧）
 */
export function paperIsLight(): boolean {
  const tile = paperSampleCanvas();
  const context = tile.getContext("2d");
  if (!context || tile.width === 0 || tile.height === 0) {
    return false;
  }
  const { data } = context.getImageData(0, 0, tile.width, tile.height);
  let total = 0;
  let count = 0;
  // 隔 16 个像素采样一次即可，不必逐点算（这里只做观感判断）
  for (let i = 0; i < data.length; i += 64) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    total += (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    count += 1;
  }
  return count > 0 && total / count > 0.62;
}

/**
 * 加载并解码一张图片（纸张素材用）。
 *
 * 用 `Image` 而不是 `fetch` + `createImageBitmap`：插件本体不允许发网络请求
 * （CI 边界规则第 3 条），图片地址由宿主的资源管线给出，浏览器自己取图。
 *
 * @param url 图片地址
 * @returns 解码完成的图片
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // 同域素材不需要匿名跨域；加了也能兼容 CDN 场景
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`纸张素材加载失败：${url}`));
    image.src = url;
  });
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

  // ① 纸张底：按当前铺法铺（平铺 / 整幅拉伸），并且只铺这一区域
  fillPaperRegion(context, left, top, runWidth, bottom - top, boardWidth, boardHeight, left, top);

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
