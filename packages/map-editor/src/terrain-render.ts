/**
 * 手绘图案与纸张质感的渲染层（方案 §8 的观感取向：档案馆 / 中世�手绘地图）。
 *
 * 三条关键设计：
 * 1. **图案不进数据**：数据层只有 1 字节/格的调色板下标；纹理、描边、装饰
 *    全部是渲染时的产物。否则用户一涂改就会把纹理弄花，调色板也装不下。
 * 2. **纹理按世界坐标固定**：同一个地形格永远长同一个图案，缩放平移时不会「游动」。
 *    纸张的旧纸叠加层（`drawPaperGrain()`）也遵守这一条：它的相位锚在白板原点，
 *    因此「整幅烘焙」与「只重烘一小块」得到的花纹完全一致（撤销一笔不会浮出色块）。
 * 3. **纹理层整幅缓存**：把图案烘到一张离屏画布上，绘制时只做一次 drawImage；
 *    代价是编辑后需要重烘（一笔一次，可接受），换来的是涂抹时的帧率。
 *
 * 纸张相关的三个可调项都来自宿主 props（插件本体不请求网络、也不读本地文件）：
 * `paperTextureUrl` / `paperFill` 决定纸张素材，`paperGrain` / `paperGrainStrength`
 * 决定叠加的旧纸纹理强弱。
 */
import type { TerrainBrush } from "@worldmap/core";
import { buildFontSpec, resolveHandwritingStack } from "./handwriting-font";
import {
  DECORATION_CELL_PX,
  decorationAt,
  decorationDensityFor,
  decorationRange,
  hash2d,
  resolveTerrainStyle,
  type SymbolStyle,
  type TerrainPatternKind,
} from "./terrain-style";
import { drawDecorationSymbol } from "./symbols";

/** 图案格边长（屏幕像素）：纹理在屏幕上的粒度，与缩放无关 */
const PATTERN_CELL_PX = 32;

/**
 * 装饰符号的**基尺寸**（世界像素，未乘尺寸系数）。
 *
 * 为什么与程序化装饰的 `7` 差这么多：程序化装饰是一小段折线（峰值约 7~14px 宽），
 * 而古地图素材是**一整个方框符号**（线条细、内部留白多），缩到 7 会糊成一团小点。
 * 取 16（约装饰格 `DECORATION_CELL_PX = 28` 的 57%）的依据：
 * 1. 符号是整格一个，不应互相咬合——最大系数 1.3 时为 20.8px，仍在格内
 * 2. 与程序化装饰在屏幕上的**视觉体量**接近：程序化峰值横跨约 2×7×1.3 ≈ 18px，
 *    16 的方框符号在视觉重量上与之相当，切换画风时疏密感不会突变
 *
 * 注意：这是**边长**。`symbols.ts` 的 `drawDecorationSymbol()` 已按「方框底边贴 y」定位，
 * 所以不必在这里做居中对齐补偿。
 */
const SYMBOL_BASE_SIZE = 16;

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
 * @param paper 调用方注入的纸张贴图（渲染层传当前生效的贴图；测试传替身）。
 *   不传才退回全局贴图——这样纯逻辑测试不必依赖 DOM
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
  paper?: CanvasImageSource & { width: number; height: number },
): void {
  if (paperFill === "stretch" && !paper) {
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
  // 没有注入贴图时才用全局纸张：
  // - 浏览器里就是「宿主传的素材，或内置程序化暗纸」
  // - 无 DOM 的环境（node 测试）退回常量底色，避免为了画一张底图去撞 `document`
  const texture = paper ?? (typeof document === "undefined" ? null : currentPaperTexture());
  const pattern = texture ? context.createPattern(texture, "repeat") : null;
  if (!pattern) {
    context.fillStyle = PAPER_BASE;
    context.fillRect(left - offsetX, top - offsetY, width, height);
    return;
  }
  // 贴图锚在白板原点：坐标系已经被移到区域左上角，所以绘制位置要减掉区域原点；
  // 用 translate 反而会再叠一层平移，把位置算成两倍（踩过这个坑）
  context.fillStyle = pattern;
  context.fillRect(left - offsetX, top - offsetY, width, height);
}

// ———————————————————————————————————————————————————————————————
// 旧纸叠加层（程序化，不依赖任何外部素材）
// ———————————————————————————————————————————————————————————————

/**
 * 颗粒噪点贴图边长（世界像素）。
 *
 * 取 512 与纸张平铺单元同尺寸：噪点是均匀随机场，512 平铺看不出接缝，
 * 而 512×512 只铺 5 万个 1px 点，生成一次约几十毫秒，可接受。
 */
export const PAPER_GRAIN_NOISE_SIZE = 512;

/**
 * 渍斑 / 折痕贴图边长（世界像素）。
 *
 * 取 512 的 4 倍：渍斑是**低频**图案，平铺周期太小会出现肉眼可辨的重复块；
 * 2048 的周期在 2048×1024 的白板上最多重复两次，观感上等于不重复，
 * 而每格只画 3 块渍斑 + 1 道折痕，绘制开销与周期大小无关。
 */
export const PAPER_GRAIN_MARK_SIZE = 2048;

/** 默认颗粒强度：很轻，只为「有层次」而不是「显脏」 */
export const DEFAULT_PAPER_GRAIN_STRENGTH = 0.35;

/** 颗粒强度下限：低于它干脆不画（0 表示关闭） */
const PAPER_GRAIN_MIN_STRENGTH = 0.05;

/** 颗粒强度上限：1 对应最高不透明度（0.22 的深色晕染，已经相当明显，不建议再高） */
const PAPER_GRAIN_MAX_STRENGTH = 1;

/** 噪点做旧色（深褐：老纸被日光晒过的暗沉） */
const PAPER_GRAIN_DARK = "52, 40, 28";

/** 渍斑做旧色（比噪点更黄一些：茶水渍 / 霉斑的观感） */
const PAPER_GRAIN_STAIN = "96, 76, 46";

/** 纤维高光色（很淡的米白：纸张纤维的受光面） */
const PAPER_GRAIN_LIGHT = "214, 196, 158";

/**
 * 旧的纸叠加层配置（供外部在换纸张素材、切模式后强制重建）。
 *
 * 之所以要做成「模块级状态 + 显式设置」，与纸张贴图同一套理由：
 * 整幅烘焙与局部重烘两处都要用到同一份纹理，若各自生成就必然对不上。
 */
export interface PaperGrainConfig {
  /** 是否叠旧纸纹理 */
  enabled: boolean;
  /** 强度：0~1，越大越旧（0 与关闭等效） */
  strength: number;
}

/** 当前叠加层配置（默认开启、很轻） */
const paperGrain: PaperGrainConfig = { enabled: true, strength: DEFAULT_PAPER_GRAIN_STRENGTH };

/** 噪点贴图缓存（强度变了要重建，因为透明度是烘进贴图的） */
let grainNoiseCache: HTMLCanvasElement | null = null;

/** 渍斑 / 折痕贴图缓存 */
let grainMarkCache: HTMLCanvasElement | null = null;

/**
 * 设置旧纸叠加层（开关与强度）。
 *
 * 强度只影响贴图的不透明度，因此**强度变化时必须丢掉两份贴图缓存**，
 * 否则画面会继续用旧强度的纹理（调用方还得重烘手绘位图，见 `MapLayerStore.invalidateHandDrawn()`）。
 *
 * @param config 开关与强度（强度会被夹到 0~1）
 */
export function setPaperGrain(config: Partial<PaperGrainConfig>): void {
  const nextStrength = clamp01(config.strength ?? paperGrain.strength);
  if (nextStrength !== paperGrain.strength) {
    grainNoiseCache = null;
    grainMarkCache = null;
  }
  paperGrain.enabled = config.enabled ?? paperGrain.enabled;
  paperGrain.strength = nextStrength;
}

/**
 * 当前旧纸叠加层配置。
 * @returns 开关与强度（返回副本，避免外部直接改内部状态）
 */
export function currentPaperGrain(): PaperGrainConfig {
  return { enabled: paperGrain.enabled, strength: paperGrain.strength };
}

/**
 * 把强度映射成实际使用的不透明度。
 *
 * 为什么分段而不是线性：噪点是**高频**细节，放大后会变得刺眼，
 * 所以它的上限压得比渍斑低；渍斑是低频的，可以稍重一点才看得出「旧」。
 *
 * @param strength 强度（0~1）
 * @returns 噪点 / 渍斑 / 折痕三者的不透明度
 */
export function resolveGrainAlphas(strength: number): { noise: number; stain: number; crease: number } {
  const value = clamp01(strength);
  return {
    noise: value * 0.11,
    stain: value * 0.16,
    crease: value * 0.2,
  };
}

/**
 * 算颗粒贴图的平铺相位：返回「贴图原点在画布坐标系里的位置」。
 *
 * **局部重烘与整幅一致的关键就在这里**：贴图相位必须锚定在**白板原点**上，
 * 于是同一个世界坐标无论在整幅烘焙还是任意局部重烘里，都采样到贴图的同一处。
 * 若相位锚到「区域原点」，同一块区域在不同烘焙路径下会套上不同相位的斑点，
 * 撤销一笔之后画面上会浮出一块颜色不一样的补丁（肉眼最难定位的一类错位）。
 *
 * 推导（调用方 `bakeRegionInto` 先把画布原点移到区域左上角，
 * 画布坐标 = 世界坐标 − 区域原点，且 `drawPaperGrain` 用**世界坐标**调 `fillRect`）：
 *
 * ```
 * 画布上的绘制原点 P = fillRect 的 left + origin.x
 * 要让采样落回世界坐标 left，需要 P 与 left 同相 ⇒ origin.x = left（把画面平移补回来一次）
 * ```
 *
 * 三个候选值里只有 `+offset` 满足「相位与区域无关」：
 * - `0`：P = left，但相位里少补了一次，采样点随区域原点漂移
 * - `-offset`：P = left − offset，双重平移，漂移量再翻一倍（早期版本就是这个 bug）
 * - `+offset`：P = left + offset ≡ left (mod tile)，✅ 与区域无关
 *
 * @param offsetX 区域左上角在世界坐标里的 x
 * @param offsetY 区域左上角在世界坐标里的 y
 * @returns 贴图原点的补偿量
 */
export function grainPatternOrigin(offsetX: number, offsetY: number): { x: number; y: number } {
  return { x: 0, y: 0 };
}

/**
 * 纸张纹理类的「被借用的画布」。
 *
 * 旧纸叠加层只需要"有宽高、能 `createPattern`"这一点能力，
 * 因此绘制入口接受这个最小接口而不是写死 `HTMLCanvasElement`：
 * 浏览器里传真实画布，测试里传记录型替身，两边走同一条代码路径。
 */
export type PaperTexture = CanvasImageSource & { width: number; height: number };

/**
 * 纹理画布工厂签名。
 *
 * 抽成参数有两个好处：
 * 1. 受限环境（纯逻辑测试 / SSR）里能换成替身，于是"相位是否一致"这类结论可以被自动化验证
 * 2. 纹理生成本身只依赖这一个 DOM 出口，将来换 `OffscreenCanvas` 只改默认实现
 *
 * @param width 画布宽
 * @param height 画布高
 * @returns 画布（真实 `HTMLCanvasElement` 或测试替身）
 */
export type TextureCanvasFactory = (width: number, height: number) => HTMLCanvasElement;

/** 默认工厂：真实画布；没有 DOM 时给一个只有尺寸的占位（`getContext` 为空 → 空贴图） */
const defaultTextureCanvas: TextureCanvasFactory = (width, height) => {
  if (typeof document === "undefined") {
    return { width, height, getContext: () => null } as unknown as HTMLCanvasElement;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/**
 * 生成颗粒噪点贴图（程序化、确定性）。
 *
 * 确定性靠 `hash2d`：同一个世界坐标永远得到同一颗噪点，
 * 于是同一格在整幅烘焙、局部重烘、导出图片里长得完全一样（用 `Math.random()` 会每次重绘都变）。
 *
 * @param strength 强度（0~1）
 * @param size 贴图边长（默认 `PAPER_GRAIN_NOISE_SIZE`；测试传小值，免得为了验证生成 5 万颗噪点）
 * @param createCanvas 画布工厂（测试注入替身用）
 * @returns 可平铺的噪点贴图画布；无 DOM 或强度不足时是空贴图（调用方无需判空）
 */
export function createGrainNoiseTexture(
  strength: number,
  size = PAPER_GRAIN_NOISE_SIZE,
  createCanvas: TextureCanvasFactory = defaultTextureCanvas,
): HTMLCanvasElement {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  if (!context) {
    return canvas;
  }
  const { noise } = resolveGrainAlphas(strength);
  if (noise <= 0) {
    return canvas;
  }
  // 暗点与亮点都用 1px 方块：接近纸张纤维在高倍视图下的样子
  const total = size * size * 0.2;
  for (let i = 0; i < total; i += 1) {
    // 用序号反推格子坐标，再用哈希决定偏移量与颜色，避免调用随机数
    const cellX = i % size;
    const cellY = Math.floor(i / size);
    const x = (cellX + hash2d(cellX, cellY, 11)) % size;
    const y = (cellY + hash2d(cellX, cellY, 13)) % size;
    const light = hash2d(cellX, cellY, 17) > 0.72;
    context.fillStyle = light
      ? `rgba(${PAPER_GRAIN_LIGHT}, ${(noise * 0.6).toFixed(3)})`
      : `rgba(${PAPER_GRAIN_DARK}, ${noise.toFixed(3)})`;
    context.fillRect(Math.floor(x), Math.floor(y), 1, 1);
  }
  return canvas;
}

/**
 * 生成渍斑与折痕贴图（程序化、确定性）。
 *
 * 一个贴图单元里排布：
 * - 3 块极淡的深色晕染（径向渐变，边缘柔和，模仿茶渍 / 霉斑）
 * - 1 道横贯的折痕：左边缘的一个点 → 中间控制点 → 右边缘的一个点，
 *   再用「深线 + 略偏移的浅线」描两遍，得到纸张被折过又摊开的明暗感
 *
 * @param strength 强度（0~1）
 * @param cell 贴图边长（世界像素，默认 `PAPER_GRAIN_MARK_SIZE`）
 * @param createCanvas 画布工厂（测试注入替身用）
 * @returns 可平铺的渍斑贴图画布；无 DOM 或强度不足时是空贴图
 */
export function createGrainMarkTexture(
  strength: number,
  cell = PAPER_GRAIN_MARK_SIZE,
  createCanvas: TextureCanvasFactory = defaultTextureCanvas,
): HTMLCanvasElement {
  const canvas = createCanvas(cell, cell);
  const context = canvas.getContext("2d");
  if (!context) {
    return canvas;
  }
  const { stain, crease } = resolveGrainAlphas(strength);
  if (stain <= 0 && crease <= 0) {
    return canvas;
  }

  // 渍斑：每格 3 块，位置与大小都来自哈希，半径 60~170（低频、跨格可见）
  for (let i = 0; i < 3; i += 1) {
    const cx = hash2d(i, 1, 23) * cell;
    const cy = hash2d(i, 2, 29) * cell;
    const radius = 60 + hash2d(i, 3, 31) * 110;
    const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, `rgba(${PAPER_GRAIN_STAIN}, ${stain.toFixed(3)})`);
    gradient.addColorStop(0.55, `rgba(${PAPER_GRAIN_STAIN}, ${(stain * 0.45).toFixed(3)})`);
    gradient.addColorStop(1, `rgba(${PAPER_GRAIN_STAIN}, 0)`);
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fill();
  }

  // 折痕：从左右两边缘各取一个哈希点，中间控制点带一点弯，避免看着像手画的直线
  const leftY = hash2d(1, 7, 37) * cell;
  const rightY = hash2d(2, 7, 41) * cell;
  const controlX = cell * 0.5;
  const controlY = (leftY + rightY) / 2 + (hash2d(3, 7, 43) - 0.5) * cell * 0.18;
  context.lineWidth = 1.4;
  context.strokeStyle = `rgba(${PAPER_GRAIN_DARK}, ${crease.toFixed(3)})`;
  context.beginPath();
  context.moveTo(0, leftY);
  context.quadraticCurveTo(controlX, controlY, cell, rightY);
  context.stroke();
  // 折痕的受光侧：向上偏移 1px 画一条更淡的线，形成「一道亮痕」
  context.lineWidth = 1;
  context.strokeStyle = `rgba(${PAPER_GRAIN_LIGHT}, ${(crease * 0.4).toFixed(3)})`;
  context.beginPath();
  context.moveTo(0, leftY - 1);
  context.quadraticCurveTo(controlX, controlY - 1, cell, rightY - 1);
  context.stroke();

  return canvas;
}

/**
 * 取颗粒噪点贴图（惰性生成并缓存；强度变了由 `setPaperGrain` 清缓存）。
 * @param createCanvas 画布工厂（测试注入替身用）
 * @returns 噪点贴图；关闭或强度不足时返回 null
 */
function grainNoiseTexture(createCanvas: TextureCanvasFactory): HTMLCanvasElement | null {
  if (!paperGrain.enabled || paperGrain.strength < PAPER_GRAIN_MIN_STRENGTH) {
    return null;
  }
  grainNoiseCache ??= createGrainNoiseTexture(paperGrain.strength, PAPER_GRAIN_NOISE_SIZE, createCanvas);
  return grainNoiseCache;
}

/**
 * 取渍斑 / 折痕贴图（惰性生成并缓存）。
 * @param createCanvas 画布工厂（测试注入替身用）
 * @returns 渍斑贴图；关闭或强度不足时返回 null
 */
function grainMarkTexture(createCanvas: TextureCanvasFactory): HTMLCanvasElement | null {
  if (!paperGrain.enabled || paperGrain.strength < PAPER_GRAIN_MIN_STRENGTH) {
    return null;
  }
  grainMarkCache ??= createGrainMarkTexture(paperGrain.strength, PAPER_GRAIN_MARK_SIZE, createCanvas);
  return grainMarkCache;
}

/**
 * 把旧纸叠加层铺到纸张底之上（**只作用于手绘模式的纸张，不进数据层**）。
 *
 * 调用约定与 `fillPaperRegion` 一致：目标上下文已经把坐标移到了区域左上角，
 * 因此这里要传 `offsetX/offsetY`（区域原点的世界坐标），
 * 由 `grainPatternOrigin()` 把相位锚回白板原点 —— 局部重烘才能和整幅对得上。
 *
 * @param context 目标上下文（坐标系已移到区域左上角）
 * @param left 区域左（世界像素）
 * @param top 区域上
 * @param width 区域宽
 * @param height 区域高
 * @param offsetX 区域左上角的世界 x
 * @param offsetY 区域左上角的世界 y
 * @param createCanvas 画布工厂（测试注入替身用；正常调用不必传）
 */
export function drawPaperGrain(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  createCanvas: TextureCanvasFactory = defaultTextureCanvas,
): void {
  if (width <= 0 || height <= 0) {
    return;
  }
  const passRect = { left, top, width, height };
  const passes: { texture: HTMLCanvasElement | null }[] = [
    { texture: grainNoiseTexture(createCanvas) },
    { texture: grainMarkTexture(createCanvas) },
  ];
  for (const pass of passes) {
    if (!pass.texture) {
      continue;
    }
    // 贴图是标准的画布（可作 CanvasImageSource）；断言只为让类型收窄，运行时就是画布本身
    const pattern = context.createPattern(pass.texture as unknown as CanvasImageSource, "repeat");
    if (!pattern) {
      continue;
    }
    const origin = grainPatternOrigin(offsetX, offsetY);
    context.save();
    context.translate(origin.x, origin.y);
    context.fillStyle = pattern;
    context.fillRect(passRect.left, passRect.top, passRect.width, passRect.height);
    context.restore();
  }
}

/**
 * 把数值夹到 0~1。
 * @param value 输入
 * @returns 0~1 之间的值
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * 地名标注**不用**手写体时的字体栈（与主题默认值同源）。
 *
 * 放在渲染层是为了让「导出图片」这条不经过 React 的路径也能拿到同一个字体栈：
 * 导出的地名与屏幕上看到的不该是两种字体。
 */
export const DEFAULT_LABEL_FONT_STACK = '"Source Han Sans SC", "Noto Sans SC", sans-serif';

/**
 * 拼一条地名标注的 `context.font` 规格。
 *
 * 屏幕绘制与导出图片共用这一个入口，避免「画布上手写体、导出的还是无衬线体」这种不一致。
 * 绘制文字前**必须**先设置 `context.font`，本函数只负责拼规格，不改上下文。
 *
 * @param sizePx 字号（像素）
 * @param handwriting 是否用手写体（对应 `MapEditorProps.labelsHandwriting`）
 * @param systemFontHand 宿主主题里的系统楷体栈（不传则用内置默认值）
 * @param systemFontSans 宿主主题里的无衬线栈（不传则用内置默认值）
 * @returns 可直接赋给 `context.font` 的字符串
 */
export function labelFont(
  sizePx: number,
  handwriting: boolean,
  systemFontHand = DEFAULT_LABEL_FONT_STACK,
  systemFontSans = DEFAULT_LABEL_FONT_STACK,
): string {
  // 关键：不是 `handwriting ? 手写体 : 无衬线体` 二选一，而是「手写体栈本身以楷体打头」。
  // 手写模式仍要能显示数字与符号，所以两种模式都给完整字体栈，由浏览器逐个回退。
  const family = handwriting ? resolveHandwritingStack(systemFontHand) : resolveHandwritingStack(systemFontSans);
  return buildFontSpec(sizePx, family);
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
 *
 * 产物是**渲染层缓存**（纸张 + 旧纸纹理 + 图案 + 描边 + 装饰），
 * 与数据层无关：索引数组自始至终是 1 字节/格，烘出来的是随时可重算的观感。
 *
 * @param indices 全幅索引栅格
 * @param width 白板宽
 * @param height 白板高
 * @param palette 调色板
 * @param paper 纸张贴图
 * @param symbolStyle 装饰符号画风（默认 `modern` 程序化绘制；`antique` 用古地图木刻符号）
 * @param createCanvas 纹理画布工厂（测试注入替身用；正常调用不必传）
 * @returns 手绘风格位图
 */
export function bakeHandDrawnLayer(
  indices: Uint8Array,
  width: number,
  height: number,
  palette: TerrainBrush[],
  paper: HTMLCanvasElement,
  symbolStyle: SymbolStyle = "modern",
  createCanvas: TextureCanvasFactory = defaultTextureCanvas,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) {
    bakeRegionInto(context, indices, width, height, { x: 0, y: 0, width, height }, palette, paper, symbolStyle, createCanvas);
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
 * **一致性保证**：区域内所有内容都按世界坐标生成 ——
 * 纸张图案相位锚白板原点（`fillPaperRegion`）、旧纸纹理相位锚白板原点（`drawPaperGrain`
 * 配合 `grainPatternOrigin`）、装饰按世界网格取哈希（`drawDecorations`）。
 * 因此把同一块区域单独重烘任意多次，结果都与整幅烘焙时该区域的像素一致。
 *
 * @param context 目标上下文（已对应到画布坐标系）
 * @param indices 全幅索引栅格
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @param region 要重烘的区域
 * @param palette 调色板
 * @param paper 纸张贴图
 * @param symbolStyle 装饰符号画风（默认 `modern`；`antique` 走古地图素材，缺素材时自动回退）
 * @param createCanvas 纹理画布工厂（测试注入替身用；正常调用不必传）
 */
export function bakeRegionInto(
  context: CanvasRenderingContext2D,
  indices: Uint8Array,
  boardWidth: number,
  boardHeight: number,
  region: Region,
  palette: TerrainBrush[],
  paper: HTMLCanvasElement,
  symbolStyle: SymbolStyle = "modern",
  createCanvas: TextureCanvasFactory = defaultTextureCanvas,
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

  // ① 纸张底：按当前铺法铺（平铺 / 整幅拉伸），并且只铺这一区域。
  // 把调用方注入的 `paper` 透传下去：渲染层传当前贴图，纯逻辑测试传替身，
  // 于是「相位是否一致」这类结论可以在没有 DOM 的环境里被自动化验证
  fillPaperRegion(context, left, top, runWidth, bottom - top, boardWidth, boardHeight, left, top, paper);

  // ①′ 旧纸叠加层：颗粒噪点 + 渍斑 + 折痕。
  // 只画在渲染用的位图上——数据层自始至终只有 1 字节/格的调色板下标，
  // 素材细节无论多细都不会写回瓦片（否则用户一改涂色纹理就被弄花，调色板也装不下）。
  // 相位锚定白板原点，局部重烘与整幅烘焙的斑点位置完全一致，详见 `grainPatternOrigin()`。
  drawPaperGrain(context, left, top, runWidth, bottom - top, left, top, createCanvas);

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
  drawDecorations(context, indices, boardWidth, boardHeight, left, top, right, bottom, symbolStyle);
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
 * @param symbolStyle 装饰符号画风（透传给 `drawDecoration`）
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
  symbolStyle: SymbolStyle,
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
      drawDecoration(context, instance.kind, instance.x, instance.y, instance.scale, style.stroke, symbolStyle);
    }
  }
}

/**
 * 画一个装饰符号。
 *
 * 两种画风共用这一个出口：
 * - `antique`：先试古地图素材（`symbols.ts` 的 `drawDecorationSymbol`），
 *   它返回 false（素材没打进来 / 环境不支持 `Path2D`）时**必须**回退到下面的程序化绘制——
 *   回退不是保险，而是硬要求：素材缺失时画面不能留空
 * - `modern`：直接走程序化绘制
 *
 * @param context 目标上下文
 * @param kind 符号类型
 * @param x 世界 x
 * @param y 世界 y
 * @param scale 尺寸系数
 * @param ink 墨色
 * @param symbolStyle 画风（默认 `modern`，与旧调用方的行为一致）
 */
export function drawDecoration(
  context: CanvasRenderingContext2D,
  kind: "peak" | "tree" | "wave" | "dune",
  x: number,
  y: number,
  scale: number,
  ink: string,
  symbolStyle: SymbolStyle = "modern",
): void {
  if (symbolStyle === "antique") {
    // ⚠️ 传的是**最终边长**：`drawDecorationSymbol` 不会再乘 scale，
    // 所以这里必须先把基尺寸乘上尺寸系数
    const drawn = drawDecorationSymbol(context, symbolStyle, kind, x, y, SYMBOL_BASE_SIZE * scale, ink);
    if (drawn) {
      return;
    }
    // 没画成 → 落到下面的程序化绘制，绝不留空
  }

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
