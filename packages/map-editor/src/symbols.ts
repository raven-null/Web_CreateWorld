/**
 * 装饰符号的矢量绘制。
 *
 * 素材是 Kenney Cartography Pack（CC0）的矢量符号：一整套无分组、无命名的描边路径。
 * 构建期脚本按「路径包围盒相接」把它聚类成 68 个独立符号，平移到各自原点并归一到
 * `0~100` 的方框（见 `symbols-antique.ts`）。
 *
 * 两条关键设计：
 * 1. **内联进包、零网络请求**：插件要能独立安装到别的项目，不能依赖外部素材地址
 * 2. **按「风格 + 种类」缓存成离屏画布**：符号每格都要画，直接 `stroke` 几十条路径会拖慢
 *    重烘；缓存后每格只剩一次 `drawImage`
 *
 * 描边色在缓存时确定（纸张换了、地形色变了都会重建），因此缓存键里不含颜色。
 */
import { ANTIQUE_DECORATION_SYMBOLS, type DecorationKind, type SymbolStyle } from "./terrain-style";
import { ANTIQUE_SYMBOLS } from "./symbols-antique";

/** 符号缓存画布的边长（实际绘制时再缩放到装饰尺寸） */
const SYMBOL_TILE_PX = 256;

/** 画风 + 种类 → 已渲染好的符号画布 */
const cache = new Map<string, HTMLCanvasElement>();

/**
 * 取某个符号在当前画风下的可绘制画布（带缓存）。
 *
 * @param style 画风：古地图 / 简洁现代
 * @param kind 装饰类型
 * @param color 描边色
 * @returns 透明底的符号画布；画风为 modern 时返回 null（由调用方继续走程序化绘制）
 */
export function decorationSymbol(
  style: SymbolStyle,
  kind: DecorationKind,
  color: string,
): HTMLCanvasElement | null {
  if (style !== "antique") {
    return null;
  }
  const key = `${style}:${kind}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const canvas = createAntiqueSymbol(kind, color);
  if (!canvas) {
    return null;
  }
  cache.set(key, canvas);
  return canvas;
}

/**
 * 把某个素材符号描边画到一张透明底画布上。
 *
 * 路径坐标系是 `0~100` 的方框，这里统一放大到 `SYMBOL_TILE_PX`，
 * 于是调用方只要按装饰尺寸缩放这张画布即可，不用关心素材原始尺寸。
 *
 * @param kind 装饰类型
 * @param color 描边色
 * @returns 符号画布；没有 DOM、拿不到 2D 上下文、或素材里找不到该序号时返回 null
 */
function createAntiqueSymbol(kind: DecorationKind, color: string): HTMLCanvasElement | null {
  // 没有 DOM 的环境（node 测试、极简宿主）直接放弃：
  // 调用方拿到 null 会回退到程序化绘制，绝不能抛错——
  // 抛错会中断整幅手绘位图的烘焙，用户看到的是空白地图
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = SYMBOL_TILE_PX;
  canvas.height = SYMBOL_TILE_PX;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  const symbol = ANTIQUE_SYMBOLS.find((item) => item.sourceIndex === ANTIQUE_DECORATION_SYMBOLS[kind]);
  if (!symbol) {
    return null;
  }

  const scale = SYMBOL_TILE_PX / 100;
  context.scale(scale, scale);
  context.strokeStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  // 素材线条细，这里按画布尺寸补偿一点线宽，缩到装饰尺寸后才不会淡到看不见
  context.lineWidth = 0.9;
  for (const path of symbol.paths) {
    const drawable = pathOf(path.d);
    if (!drawable) {
      continue;
    }
    context.lineWidth = Math.max(0.6, path.strokeWidth * 0.55);
    context.stroke(drawable);
  }
  return canvas;
}

/** Path2D 缓存：同一段 d 字符串只解析一次 */
const pathCache = new Map<string, Path2D>();

/**
 * 把 path 数据解析成 `Path2D`（带缓存）。
 *
 * `Path2D` 支持 SVG path 语法，所以素材的 d 可以原样使用；
 * 解析有开销，而符号会被反复绘制，因此缓存起来。
 *
 * @param d path 数据
 * @returns Path2D；环境不支持时返回 null（调用方退化为不画）
 */
function pathOf(d: string): Path2D | null {
  const cached = pathCache.get(d);
  if (cached) {
    return cached;
  }
  if (typeof Path2D === "undefined") {
    return null;
  }
  try {
    const path = new Path2D(d);
    pathCache.set(d, path);
    return path;
  } catch {
    return null;
  }
}

/**
 * 把古地图符号画到指定位置。
 *
 * @param context 目标上下文
 * @param style 画风
 * @param kind 装饰类型
 * @param x 世界 x（符号左下角对齐到该点，与程序化装饰的基线一致）
 * @param y 世界 y
 * @param size 符号边长（世界像素）
 * @param color 描边色
 * @returns 是否真的画了（false 表示调用方应回退到程序化绘制）
 */
export function drawDecorationSymbol(
  context: CanvasRenderingContext2D,
  style: SymbolStyle,
  kind: DecorationKind,
  x: number,
  y: number,
  size: number,
  color: string,
): boolean {
  const symbol = decorationSymbol(style, kind, color);
  if (!symbol) {
    return false;
  }
  // 符号方框的底边贴着 y（与程序化装饰一致：装饰「站在」格子上）
  context.drawImage(symbol, x - size / 2, y - size, size, size);
  return true;
}
