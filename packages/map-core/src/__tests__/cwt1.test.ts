/**
 * `cwt1` 瓦片格式的编解码互测（方案 §6.4）。
 *
 * 这份测试同时是「两端互测」的替代：编解码器只有一份、放在零依赖的 map-core 里，
 * 网站与 Worker 用的是同一份实现，因此只要能在这份实现上往返一致，
 * 就不存在「网站存的瓦片服务端解不开」。
 */
import { describe, expect, it } from "vitest";
import {
  createNativeGzip,
  CWT1_COMPRESSION_GZIP,
  CWT1_COMPRESSION_NONE,
  CWT1_HEADER_BYTES,
  CWT1_MAX_TILE_SIZE,
  decodeTile,
  encodeTile,
  isTileEmpty,
} from "../index";

const gzip = createNativeGzip();

/** 构造一块有内容的索引栅格：左半海洋(1)、右半草地(3) */
function makeGradientTile(width = 256, height = 256): Uint8Array {
  const indices = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      indices[row * width + col] = col < width / 2 ? 1 : 3;
    }
  }
  return indices;
}

describe("cwt1 · 往返一致", () => {
  it("编码后再解码，索引逐字节一致（gzip 路径）", async () => {
    const indices = makeGradientTile();
    const encoded = await encodeTile({ indices, width: 256, height: 256 }, gzip?.compressor);
    const decoded = await decodeTile(encoded, gzip?.decompressor);
    expect(decoded.width).toBe(256);
    expect(decoded.height).toBe(256);
    expect(Array.from(decoded.indices)).toEqual(Array.from(indices));
  });

  it("没有压缩器时走原始字节路径，同样往返一致", async () => {
    const indices = makeGradientTile(64, 64);
    const encoded = await encodeTile({ indices, width: 64, height: 64 }, null);
    expect(encoded[8]).toBe(CWT1_COMPRESSION_NONE);
    const decoded = await decodeTile(encoded, null);
    expect(Array.from(decoded.indices)).toEqual(Array.from(indices));
  });

  it("全透明瓦片：往返一致，且判定为空瓦片", async () => {
    const indices = new Uint8Array(256 * 256);
    const encoded = await encodeTile({ indices, width: 256, height: 256 }, gzip?.compressor);
    const decoded = await decodeTile(encoded, gzip?.decompressor);
    expect(Array.from(decoded.indices)).toEqual(Array.from(indices));
    expect(isTileEmpty(decoded.indices)).toBe(true);
  });

  it("非 256 的瓦片边长（白板宽非 256 倍数时会出现）", async () => {
    const indices = makeGradientTile(128, 64);
    const encoded = await encodeTile({ indices, width: 128, height: 64 }, gzip?.compressor);
    const decoded = await decodeTile(encoded, gzip?.decompressor);
    expect(decoded.width).toBe(128);
    expect(decoded.height).toBe(64);
    expect(Array.from(decoded.indices)).toEqual(Array.from(indices));
  });
});

describe("cwt1 · 头部与压缩标识", () => {
  it("头部写入正确的魔数与尺寸", async () => {
    const indices = new Uint8Array(16 * 8);
    const encoded = await encodeTile({ indices, width: 16, height: 8 }, null);
    expect(encoded.length).toBe(CWT1_HEADER_BYTES + indices.length);
    expect(String.fromCharCode(encoded[0] ?? 0, encoded[1] ?? 0, encoded[2] ?? 0, encoded[3] ?? 0)).toBe("CWT1");
    // 小端 16 = 0x10, 8 = 0x08
    expect(encoded[4]).toBe(16);
    expect(encoded[5]).toBe(0);
    expect(encoded[6]).toBe(8);
    expect(encoded[7]).toBe(0);
  });

  it("内容单调（左半右半各一色）时 gzip 生效且体积明显变小", async () => {
    const indices = makeGradientTile();
    const encoded = await encodeTile({ indices, width: 256, height: 256 }, gzip?.compressor);
    expect(encoded[8]).toBe(CWT1_COMPRESSION_GZIP);
    // 原始 64KB，压缩后应显著小于 1/4
    expect(encoded.length).toBeLessThan(indices.length / 4);
  });

  it("压缩后反而更大时退回原始字节", async () => {
    // 随机数据几乎不可压缩
    const random = new Uint8Array(256 * 256);
    for (let i = 0; i < random.length; i += 1) {
      random[i] = (i * 2654435761) % 256;
    }
    const encoded = await encodeTile({ indices: random, width: 256, height: 256 }, gzip?.compressor);
    const decoded = await decodeTile(encoded, gzip?.decompressor);
    expect(Array.from(decoded.indices)).toEqual(Array.from(random));
  });
});

describe("cwt1 · 非法输入", () => {
  it("数据长度与尺寸不符时编码报错", async () => {
    await expect(encodeTile({ indices: new Uint8Array(10), width: 4, height: 4 }, null)).rejects.toThrow();
  });

  it("尺寸超过上限时报错", async () => {
    const tooBig = CWT1_MAX_TILE_SIZE + 1;
    await expect(encodeTile({ indices: new Uint8Array(tooBig * 1), width: tooBig, height: 1 }, null)).rejects.toThrow();
  });

  it("魔数不对时解码报错", async () => {
    const bytes = new Uint8Array(CWT1_HEADER_BYTES + 4);
    bytes.set([0x50, 0x4e, 0x47, 0x21]); // "PNG!"
    await expect(decodeTile(bytes, null)).rejects.toThrow(/魔数/);
  });

  it("数据过短时解码报错", async () => {
    await expect(decodeTile(new Uint8Array(4), null)).rejects.toThrow(/过短/);
  });

  it("gzip 数据但未提供解压器时报错（真实场景：旧 WebView）", async () => {
    const indices = makeGradientTile();
    const encoded = await encodeTile({ indices, width: 256, height: 256 }, gzip?.compressor);
    expect(encoded[8]).toBe(CWT1_COMPRESSION_GZIP);
    await expect(decodeTile(encoded, null)).rejects.toThrow(/未提供解压器/);
  });

  it("未知压缩标识时报错", async () => {
    const indices = new Uint8Array(16);
    const encoded = await encodeTile({ indices, width: 4, height: 4 }, null);
    encoded[8] = 9;
    await expect(decodeTile(encoded, null)).rejects.toThrow(/未知的压缩标识/);
  });
});
