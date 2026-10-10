/**
 * 经纬网密度（格子大小）的单元测试。
 *
 * 用户诉求是「格子做小一点」，但不能小到糊成一片，
 * 因此这里同时验证两件事：档位能变细、屏幕密度下限能兜住。
 */
import { describe, expect, it } from "vitest";
import {
  GRID_AUTO,
  GRID_INTERVALS_DEG,
  gridChoiceLabel,
  nextGridChoice,
  planGrid,
  type GridContext,
} from "@worldmap/core";

/** 默认白板的计算上下文 */
const base: GridContext = {
  boardWidth: 2048,
  boardHeight: 1024,
  zoom: 1,
  choice: GRID_AUTO,
  minScreenGap: 28,
};

describe("经纬网密度", () => {
  it("默认档位（30°）太粗：2048 宽的白板上只有 12×6 个格子", () => {
    const plan = planGrid({ ...base, choice: 30 });
    // 每度约 5.69px（2048/360），每度约 5.69px（1024/180）
    expect(plan.lonGapPx).toBeCloseTo(170.67, 1);
    expect(plan.latGapPx).toBeCloseTo(170.67, 1);
    expect(360 / plan.intervalDeg).toBeCloseTo(12, 5);
    expect(180 / plan.intervalDeg).toBeCloseTo(6, 5);
  });

  it("1× 缩放下 5° 能用（约 28.4px 间距，72×36 个格子）", () => {
    const plan = planGrid({ ...base, choice: 5 });
    expect(plan.intervalDeg).toBe(5);
    expect(plan.reason).toBe("user");
    expect(plan.lonGapPx).toBeCloseTo(28.44, 1);
    expect(360 / plan.intervalDeg).toBeCloseTo(72, 5);
    expect(180 / plan.intervalDeg).toBeCloseTo(36, 5);
  });

  it("再细的 2° 在 1× 下会被挡住，自动降到 5°", () => {
    const plan = planGrid({ ...base, choice: 2 });
    expect(plan.intervalDeg).toBe(5);
    expect(plan.reason).toBe("too-dense");
    expect(plan.lonGapPx).toBeGreaterThanOrEqual(base.minScreenGap);
  });

  it("放大到 5× 时 1° 才能用（2048×1024 白板下经纬线等距，判定取较小的一边）", () => {
    const atFour = planGrid({ ...base, zoom: 4, choice: 1 });
    expect(atFour.intervalDeg).toBe(2);
    expect(atFour.reason).toBe("too-dense");

    const atFive = planGrid({ ...base, zoom: 5, choice: 1 });
    expect(atFive.intervalDeg).toBe(1);
    expect(atFive.reason).toBe("user");
    expect(atFive.lonGapPx).toBeCloseTo(28.44, 1);
    expect(atFive.latGapPx).toBeCloseTo(28.44, 1);
  });

  it("缩到很小的时候，用户选的小格子会自动降到更粗的档位（不会糊）", () => {
    // 0.1× 缩放：5° 只剩约 2.8px，任何档位都不够，退回最粗的 30°
    const plan = planGrid({ ...base, zoom: 0.1, choice: 5 });
    expect(plan.reason).toBe("too-dense");
    expect(plan.intervalDeg).toBe(30);
  });

  it("自动档位：缩放越大，格子自动越细", () => {
    const zooms = [0.3, 1, 2, 4, 8, 16, 32];
    const intervals = zooms.map((zoom) => planGrid({ ...base, zoom }).intervalDeg);
    // 单调不减（不会出现"放大反而更粗"）
    for (let index = 1; index < intervals.length; index += 1) {
      expect(intervals[index] as number).toBeLessThanOrEqual(intervals[index - 1] as number);
    }
    // 放到很大时应该到最细的 1°
    expect(intervals[intervals.length - 1]).toBe(1);
  });

  it("自动档位在任何缩放下都满足屏幕间距下限", () => {
    for (const zoom of [0.05, 0.1, 0.5, 1, 3, 10, 32]) {
      const plan = planGrid({ ...base, zoom });
      const gap = Math.min(plan.lonGapPx, plan.latGapPx);
      // 极端缩小（0.05×）时最粗的 30° 也不够，此时允许不满足
      if (plan.intervalDeg !== 30) {
        expect(gap).toBeGreaterThanOrEqual(base.minScreenGap);
      }
    }
  });

  it("窄白板（宽度小）时，经线也会触发降级", () => {
    // 512 宽的白板：5° 只有约 7.1px
    const plan = planGrid({ ...base, boardWidth: 512, boardHeight: 256, choice: 5 });
    expect(plan.reason).toBe("too-dense");
    expect(plan.lonGapPx).toBeGreaterThanOrEqual(base.minScreenGap);
  });

  it("放得越大格子越细：30× 时能用到 1°", () => {
    const plan = planGrid({ ...base, zoom: 30, choice: GRID_AUTO });
    expect(plan.intervalDeg).toBe(1);
    expect(plan.lonGapPx).toBeGreaterThanOrEqual(base.minScreenGap);
  });

  it("档位循环：自动 → 30 → 15 → 10 → 5 → 2 → 1 → 自动", () => {
    let choice = GRID_AUTO;
    const seen: number[] = [];
    for (let step = 0; step < GRID_INTERVALS_DEG.length + 1; step += 1) {
      choice = nextGridChoice(choice);
      seen.push(choice);
    }
    expect(seen).toEqual([30, 15, 10, 5, 2, 1, GRID_AUTO]);
  });

  it("档位标签：自动 / 带度数符号", () => {
    expect(gridChoiceLabel(GRID_AUTO)).toBe("自动");
    expect(gridChoiceLabel(30)).toBe("30°");
    expect(gridChoiceLabel(1)).toBe("1°");
  });
});
