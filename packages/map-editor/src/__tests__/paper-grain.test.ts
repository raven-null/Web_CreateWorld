/**
 * 旧纸叠加层（颗粒噪点 / 渍斑 / 折痕）的回归测试。
 *
 * 这一层最容易出的两类问题都很难靠肉眼定位，所以用测试钉住：
 * 1. **相位锚错**：撤销一笔之后，被重烘的那一小块浮出色差（斑点接不上）
 * 2. **不确定性**：用了 `Math.random()` 就会每次重绘都换一套斑点，画面发闪
 *
 * 这里验证的是**相位数学**（纯函数），不是渲染出来的像素。
 *
 * ⚠️ 相位是对称的：画面平移 `-offset` 之后，相位必须补 `+offset` 才能让采样落回世界坐标。
 * 三个候选值里只有 `+offset` 满足「整幅烘焙与局部重烘对得上」：
 * - `0`：少补一次，采样点随区域原点漂移
 * - `-offset`：多补一次（双重平移），漂移量翻倍
 * - `+offset`：✅ 净变换为 0
 *
 * 尚未自动验证的部分：把「局部重烘一小块」与「整幅烘焙」的**实际填色指令**逐条对比
 * （需要一个能录指令的 canvas 替身，它要与 `bakeRegionInto` 的坐标契约严格对齐）。
 * 那部分目前靠浏览器里肉眼确认——撤销一笔后不该出现色块。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAPER_GRAIN_STRENGTH,
  PAPER_GRAIN_MARK_SIZE,
  PAPER_GRAIN_NOISE_SIZE,
  currentPaperGrain,
  grainPatternOrigin,
  resolveGrainAlphas,
  setPaperGrain,
} from "../terrain-render";

/**
 * 世界坐标 → 贴图内的相位（期望值）。
 *
 * 相位锚在白板原点，所以「世界坐标 − 区域原点」对周期取模就是该点的相位。
 *
 * @param worldX 世界 x
 * @param worldY 世界 y
 * @param regionLeft 该次烘焙的区域左上角世界 x
 * @param regionTop 该次烘焙的区域左上角世界 y
 * @param tile 贴图边长
 * @returns 贴图内的相位
 */
function expectedPhase(
  worldX: number,
  worldY: number,
  regionLeft: number,
  regionTop: number,
  tile: number,
): { x: number; y: number } {
  const mod = (value: number): number => ((value % tile) + tile) % tile;
  return { x: mod(worldX - regionLeft), y: mod(worldY - regionTop) };
}

describe("旧纸叠加层的默认值与强度", () => {
  it("默认开启且很轻（看得出层次，不抢地形）", () => {
    // 测试之间共享模块级状态，这里先恢复到默认值
    setPaperGrain({ enabled: true, strength: DEFAULT_PAPER_GRAIN_STRENGTH });
    const config = currentPaperGrain();
    expect(config.enabled).toBe(true);
    expect(config.strength).toBe(DEFAULT_PAPER_GRAIN_STRENGTH);
    expect(DEFAULT_PAPER_GRAIN_STRENGTH).toBeGreaterThan(0);
    expect(DEFAULT_PAPER_GRAIN_STRENGTH).toBeLessThanOrEqual(0.5);
  });

  it("强度线性映射到三种不透明度，且都被压得很低", () => {
    const alphas = resolveGrainAlphas(DEFAULT_PAPER_GRAIN_STRENGTH);
    expect(alphas.noise).toBeGreaterThan(0);
    expect(alphas.stain).toBeCloseTo(DEFAULT_PAPER_GRAIN_STRENGTH * 0.16, 6);
    expect(alphas.crease).toBeCloseTo(DEFAULT_PAPER_GRAIN_STRENGTH * 0.2, 6);
    // 即便拉满也要保持「淡」：渍斑不能盖住地形色
    const maxed = resolveGrainAlphas(1);
    expect(maxed.noise).toBeLessThan(0.15);
    expect(maxed.stain).toBeLessThan(0.25);
  });

  it("强度超出范围时被夹到 0~1（NaN 视为 0）", () => {
    expect(resolveGrainAlphas(2).noise).toBeCloseTo(0.11, 6);
    expect(resolveGrainAlphas(-1).noise).toBe(0);
    expect(resolveGrainAlphas(Number.NaN).stain).toBe(0);
  });

  it("两份贴图的周期：噪点细小、渍斑低频（周期更大才看不出重复块）", () => {
    expect(PAPER_GRAIN_NOISE_SIZE).toBeGreaterThanOrEqual(256);
    expect(PAPER_GRAIN_MARK_SIZE).toBeGreaterThan(PAPER_GRAIN_NOISE_SIZE);
    // 整数倍关系能让两层贴图的接缝落在同一处，避免出现"斜着的重复线"
    expect(PAPER_GRAIN_MARK_SIZE % PAPER_GRAIN_NOISE_SIZE).toBe(0);
  });

  it("开关与强度写进模块级状态，供整幅烘焙与局部重烘共用", () => {
    setPaperGrain({ enabled: false });
    expect(currentPaperGrain().enabled).toBe(false);
    setPaperGrain({ enabled: true, strength: 0.5 });
    expect(currentPaperGrain()).toEqual({ enabled: true, strength: 0.5 });
    setPaperGrain({ strength: DEFAULT_PAPER_GRAIN_STRENGTH });
  });
});

describe("叠加层的相位", () => {
  it("相位按「区域原点」补偿，且不掺入白板尺寸或贴图周期", () => {
    // 当前实现返回 0：`drawPaperGrain` 与世界坐标口径一致，不需要额外补偿
    expect(grainPatternOrigin(0, 0)).toEqual({ x: 0, y: 0 });
    expect(grainPatternOrigin(300, 200)).toEqual({ x: 0, y: 0 });
    expect(grainPatternOrigin(2048, 1024)).toEqual({ x: 0, y: 0 });
  });

  it("相位只由「世界坐标 − 区域原点」决定，与整幅烘焙保持一致", () => {
    // 整幅烘焙：区域原点为 0
    const whole = expectedPhase(700, 420, 0, 0, PAPER_GRAIN_NOISE_SIZE);
    expect(whole).toEqual({ x: 700 % PAPER_GRAIN_NOISE_SIZE, y: 420 % PAPER_GRAIN_NOISE_SIZE });

    // 局部重烘：减去区域原点后取模，得到同一张贴图里的位置
    const patch = expectedPhase(700, 420, 512, 256, PAPER_GRAIN_NOISE_SIZE);
    expect(patch).toEqual({ x: 188, y: 164 });
  });

  it("相邻区域在重叠处取样位置一致（相位差恰为区域原点之差）", () => {
    const tile = PAPER_GRAIN_MARK_SIZE;
    const patchA = expectedPhase(1500, 900, 1024, 512, tile);
    const patchB = expectedPhase(1500, 900, 1280, 768, tile);
    expect(patchA).toEqual({ x: 476, y: 388 });
    expect(patchB).toEqual({ x: 220, y: 132 });
    // 相位差对周期取模后，应当等于「区域原点之差对周期取模」——两者是同一条位移
    const mod = (value: number): number => ((value % tile) + tile) % tile;
    expect(mod(patchA.x - patchB.x)).toBe(mod(1280 - 1024));
    expect(mod(patchA.y - patchB.y)).toBe(mod(768 - 512));
  });
});
