/**
 * 导出为图片（方案 §9.2 / §12.2）。
 *
 * 规则（服务端对图片有 8MB 上限，这里也做同等的体积纪律）：
 * 1. 优先 `image/png`
 * 2. 超过体积上限时自动降级 `image/webp`（质量 0.9）
 * 3. 两者都超限则交给调用方提示用户（例如按视口导出或降低分辨率）
 *
 * 导出在**离屏画布**上完成：不影响当前编辑视图，也不需要用户先调整视口。
 */
import { terrainPaletteToUint32, type TerrainBrush, type TerrainBrush as Palette } from "@worldmap/core";
import { equatorCircumferenceKm, kilometersPerPixelLon } from "@worldmap/core";

/** 单文件体积上限（与主站图片接口一致：8MB） */
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

/** 导出选项 */
export interface ExportImageOptions {
  /** 白板尺寸 */
  width: number;
  height: number;
  /** 全幅索引栅格 */
  indices: Uint8Array;
  /** 调色板 */
  palette: TerrainBrush[];
  /** 是否画经纬网（每 30°） */
  includeGraticule?: boolean;
  /** 是否画比例尺条 */
  includeScaleBar?: boolean;
  /** 比例尺需要的天体半径（km） */
  radiusKm?: number;
  /** 输出倍率（1 = 原分辨率；0.5 = 一半） */
  scale?: number;
}

/** 导出结果 */
export interface ExportImageResult {
  blob: Blob;
  /** 实际使用的 MIME 类型（png 或 webp） */
  mimeType: string;
  /** 是否因超限而降级为 webp */
  downgraded: boolean;
}

/**
 * 把当前白板渲染并导出为图片。
 * @param options 导出选项
 * @returns 图片 Blob 与元信息
 * @throws 两种格式都超过体积上限时抛出
 */
export async function exportBoardImage(options: ExportImageOptions): Promise<ExportImageResult> {
  const scale = options.scale && options.scale > 0 ? options.scale : 1;
  const width = Math.max(1, Math.round(options.width * scale));
  const height = Math.max(1, Math.round(options.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前环境不支持画布导出");
  }

  // 底：透明区域用深色底，避免导出后出现大片透明（多数看图工具显示为黑块）
  context.fillStyle = "#0f1a24";
  context.fillRect(0, 0, width, height);

  // 地形：按 1:1（缩放时用 drawImage 从原尺寸位图缩放，避免逐像素重采样开销）
  const source = document.createElement("canvas");
  source.width = options.width;
  source.height = options.height;
  const sourceContext = source.getContext("2d");
  if (!sourceContext) {
    throw new Error("当前环境不支持画布导出");
  }
  sourceContext.putImageData(
    buildImageData(options.indices, options.width, options.height, options.palette),
    0,
    0,
  );
  context.imageSmoothingEnabled = scale < 1;
  context.drawImage(source, 0, 0, width, height);

  if (options.includeGraticule !== false) {
    drawGraticule(context, width, height);
  }
  if (options.includeScaleBar && options.radiusKm) {
    drawScaleBar(context, width, height, options.radiusKm);
  }

  const png = await canvasToBlob(canvas, "image/png");
  if (png.size <= MAX_EXPORT_BYTES) {
    return { blob: png, mimeType: "image/png", downgraded: false };
  }
  const webp = await canvasToBlob(canvas, "image/webp", 0.9);
  if (webp.size <= MAX_EXPORT_BYTES) {
    return { blob: webp, mimeType: "image/webp", downgraded: true };
  }
  throw new Error(
    `导出图片约 ${(webp.size / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_EXPORT_BYTES / 1024 / 1024}MB 上限，请降低分辨率后重试`,
  );
}

/**
 * 触发浏览器下载（多端差异由平台层处理；此处是 Web 实现）。
 * @param blob 文件内容
 * @param filename 文件名
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 释放对象 URL，避免长时间占用内存
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 索引栅格 → ImageData（用 Uint32 视图一次写入）。
 * @param indices 索引数据
 * @param width 宽
 * @param height 高
 * @param palette 调色板
 * @returns ImageData
 */
function buildImageData(
  indices: Uint8Array,
  width: number,
  height: number,
  palette: Palette[],
): ImageData {
  const table = terrainPaletteToUint32(palette);
  const rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  const view = new Uint32Array(rgba.buffer);
  for (let i = 0; i < indices.length; i += 1) {
    const value = indices[i] ?? 0;
    if (value === 0) {
      continue; // 透明 → 保留底色
    }
    const packed = table[value];
    view[i] = packed === undefined ? 0xff000000 : packed | 0xff000000;
  }
  return new ImageData(rgba, width, height);
}

/**
 * 画经纬网（每 30° 一条淡线）。
 * @param context 画布上下文
 * @param width 宽
 * @param height 高
 */
function drawGraticule(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.strokeStyle = "rgba(232, 224, 211, 0.16)";
  context.lineWidth = Math.max(1, Math.round(width / 1024));
  context.beginPath();
  for (let lon = -180; lon <= 180; lon += 30) {
    const x = ((lon + 180) / 360) * width;
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let lat = -90; lat <= 90; lat += 30) {
    const y = ((90 - lat) / 180) * height;
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
}

/**
 * 画比例尺条（以赤道比例计，底部居中）。
 * @param context 画布上下文
 * @param width 宽
 * @param height 高
 * @param radiusKm 天体半径
 */
function drawScaleBar(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  radiusKm: number,
): void {
  const board = { width, height, projection: "equirect" as const, radiusKm };
  const kmPerPixel = kilometersPerPixelLon(board, 0);
  // 取一个整数刻度，长度控制在图宽的 1/5 左右
  const targetKm = kmPerPixel * (width / 5);
  const exponent = Math.floor(Math.log10(targetKm));
  const candidates = [1, 2, 5, 10].map((m) => m * Math.pow(10, exponent));
  let bestKm = candidates[0] ?? targetKm;
  for (const candidate of candidates) {
    if (Math.abs(candidate - targetKm) < Math.abs(bestKm - targetKm)) {
      bestKm = candidate;
    }
  }
  const barPixels = bestKm / kmPerPixel;
  const barHeight = Math.max(4, Math.round(height * 0.008));
  const margin = Math.round(height * 0.04);
  const x = (width - barPixels) / 2;
  const y = height - margin - barHeight;

  context.fillStyle = "rgba(20, 18, 15, 0.7)";
  context.fillRect(x - barHeight, y - barHeight, barPixels + barHeight * 2, barHeight * 3);
  context.fillStyle = "#c9a15c";
  context.fillRect(x, y, barPixels, barHeight);
  context.fillStyle = "#e8e0d3";
  context.font = `${Math.max(11, Math.round(height * 0.022))}px "Source Han Sans SC", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "bottom";
  const label = bestKm >= 1000 ? `${Math.round(bestKm / 1000)} 千 km` : `${Math.round(bestKm)} km`;
  context.fillText(label, width / 2, y - barHeight * 0.6);
  context.textAlign = "start";
}

/**
 * 画布转 Blob。
 * @param canvas 画布
 * @param mimeType MIME 类型
 * @param quality 质量（webp / jpeg 用）
 * @returns Blob
 */
function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("导出图片失败"));
        }
      },
      mimeType,
      quality,
    );
  });
}

/** 赤道周长（供界面提示「这个世界有多大」） */
export { equatorCircumferenceKm };
