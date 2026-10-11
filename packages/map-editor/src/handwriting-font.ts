/**
 * 地名手写体：字体栈、按需加载与降级。
 *
 * ## 为什么默认不用自带字体文件
 *
 * 候选字体是「霞鹜文楷 LXGW WenKai」（SIL OFL 1.1，可商用），字形很适合手绘地图。
 * 但它**完整中文字库极大**：`@fontsource/lxgw-wenkai` 里 `lxgw-wenkai-latin-500-normal.woff2`
 * 单个文件 7.2MB（该包只有 300 / 500 / 700 三档字重，没有 400）。
 * 把这份字体无条件打进插件产物，等于让**每一个**打开编辑器的用户都先下 7.2MB ——
 * 而地名对多数用户只是锦上添花。所以做成：
 *
 * 1. 插件本体**只提供系统楷体字体栈**（零下载，Windows / macOS 都自带，观感已经"手写"）
 * 2. 想要跨端统一观感时，**宿主**把字体文件托管到自己的静态资源 / CDN，
 *    用户开启「手写地名」后把地址经 `MapEditorProps.handwritingFontUrl` 交给插件
 * 3. 插件用 `FontFace` 按需加载（不是 `fetch`，所以不违反边界规则第 3 条），
 *    加载成功就把它插到字体栈最前面；失败 / 超时则静默降级到系统楷体
 *
 * 素材本身仍然登记在 `packages/map-editor/assets/fonts/`（含 LICENSES 说明），
 * 供宿主直接拷走托管 —— 插件运行时不会自己去读那个目录。
 *
 * ## 为什么加载逻辑是有状态的
 *
 * 画布上的 `context.font` 只认「字体族名」字符串，没地方携带"这个字体加载好了没有"，
 * 于是与纸张贴图同样的做法：模块级状态 + 显式设置。这样
 * `bakeHandDrawnLayer`（导出图片）与实时绘制拿到的是同一串字体栈。
 */

/**
 * 插件加载字体时向浏览器注册的字体族名。
 *
 * 刻意不叫 `LXGW WenKai`、也不用素材原字体的名字：宿主可能同时自己加载同一字体，
 * 用独立名字可以避免「谁覆盖谁」的歧义，也便于卸载。
 */
export const HANDWRITING_FONT_FAMILY = "WME Hand";

/** 默认加载超时（毫秒）：超过就降级，绝不让界面停在"加载中" */
export const DEFAULT_HANDWRITING_TIMEOUT_MS = 8000;

/** 手写字体加载状态（与契约里的 `HandwritingFontState` 同构，此处避免反向依赖） */
export type HandwritingStatus = "idle" | "loading" | "ready" | "fallback";

/** 当前成功加载的字体族名（null = 还没加载过，或加载失败） */
let loadedFamily: string | null = null;

/** 当前正在加载（或已加载）的字体地址，用于避免重复加载同一个文件 */
let loadingUrl: string | null = null;

/** 注册表支持的字体表情形 */
interface FontFaceSetLike {
  add(font: FontFace): unknown;
  check(font: string, text?: string): boolean;
}

/**
 * 取浏览器的 `FontFaceSet`（不支持时返回 null）。
 *
 * 用类型守卫而不是 `any`：`document` 在 SSR / 测试环境里可能不存在，
 * 拿到 null 时调用方直接降级，不做无意义的加载尝试。
 *
 * @returns FontFaceSet；环境不支持时返回 null
 */
function fontFaceSet(): FontFaceSetLike | null {
  const fonts = (globalThis as { document?: { fonts?: FontFaceSetLike } }).document?.fonts;
  return fonts ?? null;
}

/** CSS 通用字体族：栈里已经有它们时不必再补一个兜底 */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
]);

/**
 * 把字体族名解析成一段可直接用的 CSS 字体栈。
 *
 * 两件事必须做对，否则画布会**静默**退回默认字体（最难查的一类问题）：
 * 1. 族名里有空格或逗号时要用引号包裹，不然整串 `context.font` 解析失败
 * 2. 栈末尾要有通用族兜底；栈里已有 `serif` / `sans-serif` 时不再重复追加
 *
 * @param stack 字体族名数组（顺序即优先级）
 * @param generic 兜底通用族（如 `serif`）
 * @returns 形如 `"WME Hand", "Kaiti SC", serif` 的字符串
 */
export function resolveFontStack(stack: string[], generic = "serif"): string {
  const families = stack
    .map((name) => name.trim().replace(/^["']|["']$/g, ""))
    .filter((name) => name.length > 0)
    .map((name) => (name.includes(" ") || name.includes(",") ? `"${name.replace(/"/g, "")}"` : name));
  const alreadyGeneric = families.some((name) => GENERIC_FAMILIES.has(name.toLowerCase()));
  return [...families, ...(alreadyGeneric ? [] : [generic])].join(", ");
}

/**
 * 解析「地名手写体」的字体栈。
 *
 * 已加载自带字体时把它放最前；否则直接用系统楷体栈——
 * 两条路径都返回**完整可用**的字体栈，调用方不需要判断"加载好了没有"。
 *
 * @param systemStack 系统楷体栈（来自主题 token `fontHand`）
 * @returns 可直接赋给 `context.font` / CSS 的字体栈
 */
export function resolveHandwritingStack(systemStack: string): string {
  const generic = "serif";
  if (!loadedFamily) {
    return resolveFontStack(systemStack.split(","), generic);
  }
  return resolveFontStack([loadedFamily, ...systemStack.split(",")], generic);
}

/**
 * 当前是否已用上自带手写字体。
 * @returns 加载成功过且仍在使用时返回 true
 */
export function handwritingFontLoaded(): boolean {
  return loadedFamily !== null;
}

/**
 * 拼一条画布文字规格（`context.font` 用）。
 *
 * @param sizePx 字号（像素）
 * @param family 字体栈（见 `resolveHandwritingStack`）
 * @param weight 字重（默认 normal；空白会让整条规格非法，因此用默认值兜底）
 * @returns 形如 `italic 18px "WME Hand", serif` 的规格字符串
 */
export function buildFontSpec(sizePx: number, family: string, weight = "normal"): string {
  const size = Number.isFinite(sizePx) && sizePx > 0 ? sizePx : 12;
  const safeWeight = weight.trim().length > 0 ? weight.trim() : "normal";
  return `${safeWeight} ${Math.round(size)}px ${family}`;
}

/**
 * 按需加载手写字体（幂等：同一个地址只加载一次）。
 *
 * 三种返回：
 * - 环境不支持 `FontFace` / `document.fonts` → `fallback`
 * - 地址已加载过且浏览器确认可用 → `ready`（不重复请求）
 * - 加载失败、超时、或浏览器加载完却说字体不可用 → `fallback`
 *
 * 任何失败都**不抛异常**：字体只是观感，不能因此让编辑器报错或白屏。
 *
 * @param url 字体文件地址（宿主提供）
 * @param timeoutMs 超时时间（毫秒）
 * @returns 加载结果状态
 */
export async function ensureHandwritingFont(url: string, timeoutMs = DEFAULT_HANDWRITING_TIMEOUT_MS): Promise<HandwritingStatus> {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return "fallback";
  }
  const fonts = fontFaceSet();
  if (!fonts || typeof FontFace === "undefined") {
    return "fallback";
  }
  const probe = `12px "${HANDWRITING_FONT_FAMILY}"`;
  // 已加载过同一个地址：浏览器确认可用就直接复用，否则当作已失效，下面重新加载
  if (loadingUrl === trimmed && fonts.check(probe)) {
    loadedFamily = HANDWRITING_FONT_FAMILY;
    return "ready";
  }
  if (loadingUrl === trimmed && loadedFamily === null) {
    // 正在加载同一个地址：等它各自超时即可，不必并发第二次请求
    return "loading";
  }
  loadingUrl = trimmed;
  loadedFamily = null;
  try {
    const face = new FontFace(HANDWRITING_FONT_FAMILY, `url("${trimmed}")`);
    const loaded = await withTimeout(face.load(), timeoutMs);
    if (!loaded) {
      return "fallback";
    }
    fonts.add(loaded);
    // 再问一次浏览器：加载成功但字体不覆盖目标文字（例如只有拉丁字形）时视为没成功
    if (!fonts.check(probe, "地名")) {
      return "fallback";
    }
    loadedFamily = HANDWRITING_FONT_FAMILY;
    return "ready";
  } catch {
    return "fallback";
  }
}

/**
 * 给一个 Promise 加超时：超时返回 null 而不是抛错。
 *
 * @param promise 待等待的 Promise
 * @param timeoutMs 超时毫秒数
 * @returns 原结果；超时或失败时返回 null
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_HANDWRITING_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), limit);
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/**
 * 重置加载状态（换字体地址 / 测试用）。
 *
 * 只改插件自己的状态，不会把已注册进浏览器的字体摘掉（那属于宿主文档的全局状态，插件不该动）。
 */
export function resetHandwritingFont(): void {
  loadedFamily = null;
  loadingUrl = null;
}
