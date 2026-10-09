/**
 * 白板改尺寸测试（最近邻重采样）。
 *
 * 重点验证「无损」与「丢细节」两类承诺是否名副其实——
 * 这些是界面要写给用户看的话，说错了比不说更糟。
 */
import { describe, expect, it } from "vitest";
import type { BoardSpec } from "@worldmap/core";
import {
  BOARD_MAX_WIDTH,
  BOARD_MIN_WIDTH,
  dataSizeRatio,
  describeResize,
  isLosslessResize,
  normalizeBoardWidth,
  resampleNearest,
} from "../resize";

/** 地球 + 2048×1024 白板 */
const BOARD: BoardSpec = {
  width: 2048,
  height: 1024,
  projection: "equirect",
  radiusKm: 6371,
};

/** 造一块 2×2 棋盘（左下与右上是草，其余是沙），便于肉眼核对像素对齐 */
function makeCheckerboard(width: number, height: number): Uint8Array {
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      indices[y * width + x] = (x + y) % 2 === 0 ? 3 : 5;
    }
  }
  return indices;
}

describe("宽度规整", () => {
  it("向上取整到 128 的倍数", () => {
    expect(normalizeBoardWidth(3000)).toBe(3072);
    expect(normalizeBoardWidth(2048)).toBe(2048);
    expect(normalizeBoardWidth(2049)).toBe(2176);
    expect(normalizeBoardWidth(128)).toBe(BOARD_MIN_WIDTH);
  });

  it("夹在允许范围内", () => {
    expect(normalizeBoardWidth(1)).toBe(BOARD_MIN_WIDTH);
    expect(normalizeBoardWidth(999999)).toBe(BOARD_MAX_WIDTH);
    expect(normalizeBoardWidth(Number.NaN)).toBe(2048);
  });
});

describe("无损判定", () => {
  it("整数倍放大判定为无损（每格精确复制成 k×k）", () => {
    expect(isLosslessResize(2048, 4096)).toBe(true);
    expect(isLosslessResize(2048, 6144)).toBe(true);
    expect(isLosslessResize(1024, 8192)).toBe(true);
    expect(isLosslessResize(2048, 2048)).toBe(true);
  });

  it("缩小一定判定为有损（细节可能消失），即使倍数很整", () => {
    expect(isLosslessResize(4096, 2048)).toBe(false);
    expect(isLosslessResize(2048, 1024)).toBe(false);
    expect(isLosslessResize(3000, 2048)).toBe(false);
  });

  it("非整数倍放大不是像素无损", () => {
    expect(isLosslessResize(2048, 3072)).toBe(false);
    expect(isLosslessResize(2048, 3000)).toBe(false);
  });
});

describe("最近邻重采样", () => {
  it("×2 放大：每格复制成 2×2，且逐字节可逆（无损往返）", () => {
    const source = makeCheckerboard(4, 4);
    const grown = resampleNearest(source, 4, 4, 8, 8);
    expect(grown.length).toBe(64);

    // 放大后每 2×2 块颜色一致
    for (let y = 0; y < 8; y += 2) {
      for (let x = 0; x < 8; x += 2) {
        const value = grown[y * 8 + x];
        expect(grown[y * 8 + x + 1]).toBe(value);
        expect(grown[(y + 1) * 8 + x]).toBe(value);
        expect(grown[(y + 1) * 8 + x + 1]).toBe(value);
      }
    }

    // 再缩小回去应与原始数据完全一致（×2 往返零损失）
    const back = resampleNearest(grown, 8, 8, 4, 4);
    expect(Array.from(back)).toEqual(Array.from(source));
  });

  it("缩小：取覆盖区域中心格的值，不会出现调色板外的值", () => {
    const source = makeCheckerboard(8, 8);
    const shrunk = resampleNearest(source, 8, 8, 4, 4);
    expect(shrunk.length).toBe(16);
    for (const value of shrunk) {
      // 只会出现原数据里存在的下标
      expect([3, 5]).toContain(value);
    }
  });

  it("尺寸不变时返回副本而不是同一引用", () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    const same = resampleNearest(source, 2, 2, 2, 2);
    expect(Array.from(same)).toEqual([1, 2, 3, 4]);
    same[0] = 9;
    expect(source[0]).toBe(1);
  });

  it("重采样只产生原调色板下标（不会污染数据）", () => {
    // 若用双线性插值，这里会出现 4 之类的中间值
    const source = new Uint8Array([1, 5, 1, 5]);
    const out = resampleNearest(source, 2, 2, 3, 3);
    for (const value of out) {
      expect([1, 5]).toContain(value);
    }
  });
});

describe("数据量与提示文案", () => {
  it("数据量倍数等于宽度比的平方", () => {
    expect(dataSizeRatio(2048, 4096)).toBeCloseTo(4, 6);
    expect(dataSizeRatio(2048, 3072)).toBeCloseTo(2.25, 6);
  });

  it("×2 幂缩放提示为无损", () => {
    const info = describeResize(BOARD, 4096);
    expect(info.level).toBe("info");
    expect(info.normalizedWidth).toBe(4096);
    expect(info.message).toContain("无损");
  });

  it("缩小提示为有损并明确会丢细节", () => {
    const info = describeResize(BOARD, 1024);
    expect(info.level).toBe("warn");
    expect(info.message).toContain("丢细节");
  });

  it("非整数倍放大提示「不会新增细节」", () => {
    const info = describeResize(BOARD, 3000);
    expect(info.normalizedWidth).toBe(3072);
    expect(info.message).toContain("不会新增细节");
  });

  it("宽度未变时给出中性提示", () => {
    const info = describeResize(BOARD, 2048);
    expect(info.message).toContain("未变化");
  });
});
