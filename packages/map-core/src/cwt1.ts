/**
 * `cwt1` 瓦片格式的编解码（方案 §6.4）。
 *
 * 为什么不用 PNG：Worker 运行时的 `DecompressionStream` 只支持 gzip / deflate，
 * 解 PNG 需要额外引入 zlib 实现；自定义格式服务端零依赖、可校验、可增量。
 *
 * 格式（小端）：
 * ```
 * 偏移 0   4B   魔数 "CWT1"
 * 偏移 4   2B   像素宽（≤ 256）
 * 偏移 6   2B   像素高（≤ 256）
 * 偏移 8   1B   压缩标识：0 = 原始字节，1 = gzip
 * 偏移 9   …    索引字节流（行优先，每格 1 字节 = 调色板下标，0 = 透明）
 * ```
 *
 * **编解码器只有这一份**，放在零依赖的 `@worldmap/core`，网站 / 桌面 / 手机共用，
 * 因此绝不会出现「网站存的瓦片应用解不开」。
 */
import type { TerrainBrush } from "./types";

/** 格式魔数 */
const MAGIC = [0x43, 0x57, 0x54, 0x31]; // "CWT1"

/** 固定头长度（字节） */
export const CWT1_HEADER_BYTES = 9;

/** 单瓦片最大边长（与瓦片划分一致） */
export const CWT1_MAX_TILE_SIZE = 256;

/** 压缩标识 */
export const CWT1_COMPRESSION_NONE = 0;
export const CWT1_COMPRESSION_GZIP = 1;

/** 编码输入 */
export interface TileEncodeInput {
  /** 调色板索引栅格，行优先，长度必须等于 width × height */
  indices: Uint8Array;
  width: number;
  height: number;
}

/** 解码结果 */
export interface TileDecodeResult {
  indices: Uint8Array;
  width: number;
  height: number;
  /** 实际使用的压缩标识 */
  compression: number;
}

/** gzip 压缩器：平台能力由调用方注入（Web / Workers 用 CompressionStream，桌面端用内置实现） */
export interface GzipCompressor {
  compress(bytes: Uint8Array): Promise<Uint8Array>;
}

/** gzip 解压器 */
export interface GzipDecompressor {
  decompress(bytes: Uint8Array): Promise<Uint8Array>;
}

/**
 * 把索引栅格编码为 `cwt1` 字节。
 *
 * @param input 索引数据与尺寸
 * @param compressor gzip 压缩器；不传则存原始字节
 * @returns 编码后的字节
 * @throws 尺寸或数据长度非法时抛出
 */
export async function encodeTile(
  input: TileEncodeInput,
  compressor?: GzipCompressor | null,
): Promise<Uint8Array> {
  const { indices, width, height } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("瓦片尺寸非法");
  }
  if (width > CWT1_MAX_TILE_SIZE || height > CWT1_MAX_TILE_SIZE) {
    throw new Error(`瓦片尺寸超过上限 ${CWT1_MAX_TILE_SIZE}`);
  }
  if (indices.length !== width * height) {
    throw new Error(`索引数据长度 ${indices.length} 与尺寸 ${width}×${height} 不符`);
  }

  let compression = CWT1_COMPRESSION_NONE;
  let payload = indices;
  if (compressor) {
    try {
      const compressed = await compressor.compress(indices);
      // 压缩后更大就没有意义（小且无规律的瓦片常见）
      if (compressed.length < indices.length) {
        payload = compressed;
        compression = CWT1_COMPRESSION_GZIP;
      }
    } catch {
      // 压缩失败不影响功能，退回原始字节
      compression = CWT1_COMPRESSION_NONE;
      payload = indices;
    }
  }

  const out = new Uint8Array(CWT1_HEADER_BYTES + payload.length);
  out[0] = MAGIC[0] ?? 0;
  out[1] = MAGIC[1] ?? 0;
  out[2] = MAGIC[2] ?? 0;
  out[3] = MAGIC[3] ?? 0;
  out[4] = width & 0xff;
  out[5] = (width >> 8) & 0xff;
  out[6] = height & 0xff;
  out[7] = (height >> 8) & 0xff;
  out[8] = compression;
  out.set(payload, CWT1_HEADER_BYTES);
  return out;
}

/**
 * 解码 `cwt1` 字节为索引栅格。
 *
 * @param bytes 待解码字节
 * @param decompressor gzip 解压器；数据为 gzip 但未提供解压器时抛出
 * @returns 解码结果
 * @throws 魔数、尺寸或数据长度非法时抛出
 */
export async function decodeTile(
  bytes: Uint8Array,
  decompressor?: GzipDecompressor | null,
): Promise<TileDecodeResult> {
  if (bytes.length < CWT1_HEADER_BYTES) {
    throw new Error("瓦片数据过短");
  }
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) {
      throw new Error("瓦片数据魔数不匹配（不是 cwt1 格式）");
    }
  }
  const width = (bytes[4] ?? 0) | ((bytes[5] ?? 0) << 8);
  const height = (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8);
  const compression = bytes[8] ?? 0;
  if (width <= 0 || height <= 0 || width > CWT1_MAX_TILE_SIZE || height > CWT1_MAX_TILE_SIZE) {
    throw new Error(`瓦片尺寸非法：${width}×${height}`);
  }

  const expected = width * height;
  const payload = bytes.subarray(CWT1_HEADER_BYTES);
  let indices: Uint8Array;

  if (compression === CWT1_COMPRESSION_GZIP) {
    if (!decompressor) {
      throw new Error("瓦片为 gzip 压缩，但未提供解压器");
    }
    indices = await decompressor.decompress(payload);
  } else if (compression === CWT1_COMPRESSION_NONE) {
    indices = payload;
  } else {
    throw new Error(`未知的压缩标识：${compression}`);
  }

  if (indices.length !== expected) {
    throw new Error(`解压后数据长度 ${indices.length} 与尺寸 ${width}×${height} 不符`);
  }
  return { indices, width, height, compression };
}

/**
 * 用于 Node / 测试环境的 gzip 实现（基于 CompressionStream）。
 * 浏览器与 Workers 可直接复用这一个，不需要额外依赖。
 * @returns 压缩器与解压器；运行环境不支持时返回 null
 */
export function createNativeGzip(): { compressor: GzipCompressor; decompressor: GzipDecompressor } | null {
  if (typeof CompressionStream === "undefined" || typeof DecompressionStream === "undefined") {
    return null;
  }
  return {
    compressor: {
      compress: (bytes) => gzipStream(bytes, "gzip", CompressionStream),
    },
    decompressor: {
      decompress: (bytes) => gzipStream(bytes, "gzip", DecompressionStream),
    },
  };
}

/**
 * 用流式压缩 / 解压 API 处理字节。
 * @param bytes 输入字节
 * @param format 压缩格式（gzip / deflate）
 * @param streamCtor CompressionStream 或 DecompressionStream 构造函数
 * @returns 处理后的字节
 */
async function gzipStream(
  bytes: Uint8Array,
  format: "gzip" | "deflate",
  streamCtor: typeof CompressionStream | typeof DecompressionStream,
): Promise<Uint8Array> {
  const stream = new streamCtor(format);
  const writer = stream.writable.getWriter();
  // 复制到独立的 ArrayBuffer：TS 的 Uint8Array 可能建立在 SharedArrayBuffer 之上，
  // 而 Web Streams 只接受普通 BufferSource
  const input = bytes.slice();
  void writer.write(new Uint8Array(input));
  void writer.close();
  const response = new Response(stream.readable);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * 判断瓦片是否「全透明」（即空瓦片）——空瓦片不落库，可省下大量存储。
 * @param indices 索引栅格
 * @returns 全部为 0 时返回 true
 */
export function isTileEmpty(indices: Uint8Array): boolean {
  for (let i = 0; i < indices.length; i += 1) {
    if (indices[i] !== 0) {
      return false;
    }
  }
  return true;
}

/** 默认地形调色板（方案 §5.1 的配色） */
export const DEFAULT_TERRAIN_PALETTE: TerrainBrush[] = [
  { index: 1, key: "ocean", name: "海洋", color: "#1d3a4e" },
  { index: 2, key: "shallow", name: "浅海", color: "#2f5a72" },
  { index: 3, key: "grass", name: "草地", color: "#5d7a4a" },
  { index: 4, key: "forest", name: "森林", color: "#3f5c3a" },
  { index: 5, key: "desert", name: "沙漠", color: "#c2a878" },
  { index: 6, key: "mountain", name: "山地", color: "#7b6a58" },
  { index: 7, key: "snow", name: "雪地", color: "#d8dfe3" },
];

/**
 * 把调色板转成 Uint32 查表，供渲染时一次写入像素（避免每像素解析颜色字符串）。
 *
 * 返回值的字节序按**小端**排布：`0xAABBGGRR`，
 * 这样配合 `Uint32Array` 视图写入 RGBA 缓冲时，内存里正好是 [R, G, B, A]。
 *
 * @param palette 调色板
 * @returns 下标 → 打包颜色
 */
export function terrainPaletteToUint32(palette: TerrainBrush[]): number[] {
  const table: number[] = [];
  for (const brush of palette) {
    const rgb = parseHexColor(brush.color);
    // 预留 alpha 位（写入时再补 0xff）
    table[brush.index] = ((rgb[2] & 0xff) << 16) | ((rgb[1] & 0xff) << 8) | (rgb[0] & 0xff);
  }
  return table;
}

/**
 * 解析 `#RGB` / `#RRGGBB` 颜色为 RGB 三元组。
 * @param hex 颜色文本
 * @returns [R, G, B]；无法解析时返回黑色
 */
function parseHexColor(hex: string): [number, number, number] {
  const text = hex.trim().replace(/^#/, "");
  if (text.length === 3) {
    const r = Number.parseInt(`${text[0]}${text[0]}`, 16);
    const g = Number.parseInt(`${text[1]}${text[1]}`, 16);
    const b = Number.parseInt(`${text[2]}${text[2]}`, 16);
    return [r || 0, g || 0, b || 0];
  }
  if (text.length >= 6) {
    const r = Number.parseInt(text.slice(0, 2), 16);
    const g = Number.parseInt(text.slice(2, 4), 16);
    const b = Number.parseInt(text.slice(4, 6), 16);
    return [r || 0, g || 0, b || 0];
  }
  return [0, 0, 0];
}
