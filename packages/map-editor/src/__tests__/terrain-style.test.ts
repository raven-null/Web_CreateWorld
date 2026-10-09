/**
 * 手绘图案的纯逻辑测试。
 *
 * 重点是**确定性**：装饰由哈希决定位置与有无，同一格必须永远长同一种装饰。
 * 若这一点坏了，画面会随重绘闪烁、导出与屏幕不一致——肉眼很难查。
 */
import { describe, expect, it } from "vitest";
import {
  DECORATION_CELL_PX,
  DEFAULT_TERRAIN_STYLES,
  decorationAt,
  decorationDensityFor,
  decorationRange,
  hash2d,
  resolveTerrainStyle,
} from "../terrain-style";

describe("稳定哈希", () => {
  it("同样的输入永远得到同样的输出", () => {
    for (const [x, y, salt] of [
      [0, 0, 0],
      [12, 34, 1],
      [-5, 7, 3],
      [999, 1234, 2],
    ] as const) {
      const first = hash2d(x, y, salt);
      const second = hash2d(x, y, salt);
      expect(first).toBe(second);
    }
  });

  it("输出落在 [0, 1)", () => {
    for (let x = -50; x < 50; x += 7) {
      for (let y = -50; y < 50; y += 11) {
        const value = hash2d(x, y, 1);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });

  it("不同 salt 得到不同结果（否则同一格的位置与尺寸会重合）", () => {
    const a = hash2d(10, 20, 1);
    const b = hash2d(10, 20, 2);
    const c = hash2d(10, 20, 3);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
  });

  it("相邻格子结果分散（不是线性的）", () => {
    const values = [0, 1, 2, 3, 4, 5].map((x) => hash2d(x, 0, 1));
    const unique = new Set(values.map((value) => value.toFixed(6)));
    expect(unique.size).toBe(values.length);
  });
});

describe("装饰散布", () => {
  it("密度为 0 时永远不出现装饰", () => {
    for (let col = 0; col < 20; col += 1) {
      expect(decorationAt(col, 0, "tree", 0)).toBeNull();
    }
  });

  it("密度为 1 时（几乎）每格都有装饰", () => {
    let count = 0;
    for (let col = 0; col < 50; col += 1) {
      if (decorationAt(col, 3, "peak", 1)) {
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(45);
  });

  it("同一格的装饰永远一致（重绘、缩放、导出都不会变）", () => {
    const first = decorationAt(7, 9, "tree", 0.5);
    const second = decorationAt(7, 9, "tree", 0.5);
    expect(first).toEqual(second);
  });

  it("装饰落在自己那一格内（含 15% 边距）", () => {
    const cell = DECORATION_CELL_PX;
    for (let col = 0; col < 12; col += 1) {
      for (let row = 0; row < 12; row += 1) {
        const instance = decorationAt(col, row, "peak", 1, cell);
        if (!instance) {
          continue;
        }
        expect(instance.x).toBeGreaterThanOrEqual(col * cell);
        expect(instance.x).toBeLessThan((col + 1) * cell);
        expect(instance.y).toBeGreaterThanOrEqual(row * cell);
        expect(instance.y).toBeLessThan((row + 1) * cell);
      }
    }
  });

  it("尺寸系数在 0.7~1.3 之间（有变化但不夸张）", () => {
    for (let col = 0; col < 40; col += 1) {
      const instance = decorationAt(col, 1, "tree", 1);
      if (!instance) {
        continue;
      }
      expect(instance.scale).toBeGreaterThanOrEqual(0.7);
      expect(instance.scale).toBeLessThanOrEqual(1.3);
    }
  });

  it("不同密度给出不同的疏密（密度越高装饰越多）", () => {
    const countWith = (density: number): number => {
      let count = 0;
      for (let col = 0; col < 200; col += 1) {
        for (let row = 0; row < 5; row += 1) {
          if (decorationAt(col, row, "wave", density)) {
            count += 1;
          }
        }
      }
      return count;
    };
    const sparse = countWith(0.2);
    const dense = countWith(0.6);
    expect(dense).toBeGreaterThan(sparse * 2);
  });
});

describe("视口范围", () => {
  it("只覆盖可见区域，并向外扩一格", () => {
    const range = decorationRange(100, 100, 200, 200, 2048, 1024, 28);
    // 100/28 ≈ 3.57 → min 3，再扩一格 → 2
    expect(range.minCol).toBe(2);
    expect(range.minRow).toBe(2);
    // (100+200)/28 ≈ 10.7 → 10，再扩一格 → 11
    expect(range.maxCol).toBe(11);
    expect(range.maxRow).toBe(11);
  });

  it("夹在白板范围内，不会越界", () => {
    const range = decorationRange(-500, -500, 100, 100, 2048, 1024, 28);
    expect(range.minCol).toBe(0);
    expect(range.minRow).toBe(0);

    const big = decorationRange(2000, 1000, 500, 500, 2048, 1024, 28);
    expect(big.maxCol).toBeLessThanOrEqual(Math.ceil(2048 / 28) - 1);
    expect(big.maxRow).toBeLessThanOrEqual(Math.ceil(1024 / 28) - 1);
  });
});

describe("样式表", () => {
  it("调色板里的常用地形都有对应样式", () => {
    for (const index of [1, 2, 3, 4, 5, 6, 7]) {
      const style = resolveTerrainStyle(index);
      expect(style.index).toBe(index);
      expect(style.stroke).toMatch(/^#/);
    }
  });

  it("未登记的下标用斜线兜底，不会抛错", () => {
    const style = resolveTerrainStyle(200);
    expect(style.pattern).toBe("hatch");
    expect(style.decoration).toBeNull();
  });

  it("海洋与森林、山地带装饰；浅海与雪地不带（避免过密）", () => {
    expect(resolveTerrainStyle(1).decoration).toBe("wave");
    expect(resolveTerrainStyle(4).decoration).toBe("tree");
    expect(resolveTerrainStyle(6).decoration).toBe("peak");
    expect(resolveTerrainStyle(2).decoration).toBeNull();
    expect(resolveTerrainStyle(7).decoration).toBeNull();
  });

  it("装饰密度：森林/山地 > 海洋 > 沙漠 > 无装饰地形", () => {
    const trees = decorationDensityFor("trees");
    const peaks = decorationDensityFor("peaks");
    const waves = decorationDensityFor("wave");
    const sand = decorationDensityFor("sand");
    const none = decorationDensityFor("dots");

    expect(trees).toBeGreaterThan(waves);
    expect(peaks).toBeGreaterThan(waves);
    expect(waves).toBeGreaterThan(sand);
    expect(none).toBe(0);
  });

  it("样式表覆盖调色板里出现的每个下标（否则会露出兜底斜线）", () => {
    const styleIndexes = new Set(DEFAULT_TERRAIN_STYLES.map((style) => style.index));
    for (const index of [1, 2, 3, 4, 5, 6, 7]) {
      expect(styleIndexes.has(index)).toBe(true);
    }
  });
});
