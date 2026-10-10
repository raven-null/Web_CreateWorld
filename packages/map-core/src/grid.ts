/**
 * 经纬网密度（方案 §5.6）。
 *
 * 白板上的「格子」就是经纬网：经线每 N° 一条、纬线每 N° 一条。
 * 30° 的格子对精确定位来说太粗，但一味改小又会在缩小视图时糊成一片，
 * 所以这里同时给出**用户档位**与**屏幕密度下限**两件事：
 *
 * - 用户从档位里挑一个（可选「自动」）
 * - 真的画线之前再过一道「屏幕间距不能小于 `minScreenGap`」的检查，
 *   太密就自动降到更粗的档位，永远不至于看不清
 *
 * 这一层是纯计算，不接触 DOM，便于单元测试与跨端复用。
 */

/** 可选档位：30° → 1°，覆盖「粗定位」到「精细绘制」 */
export const GRID_INTERVALS_DEG = [30, 15, 10, 5, 2, 1] as const;

/** 网格档位（度数） */
export type GridInterval = (typeof GRID_INTERVALS_DEG)[number];

/** 「自动」：按当前缩放挑一个最细但不糊的档位 */
export const GRID_AUTO = 0;

/** 用户选择：0 表示自动，其余为具体度数 */
export type GridIntervalChoice = number;

/** 纬线在两极附近会挤到一起，因此格子还要受纬度限制 */
export interface GridContext {
  /** 白板宽度（像素） */
  boardWidth: number;
  /** 白板高度（像素） */
  boardHeight: number;
  /** 当前缩放（屏幕像素 / 白板像素） */
  zoom: number;
  /** 用户档位（0 = 自动） */
  choice: GridIntervalChoice;
  /** 相邻网格线允许的最小屏幕间距（像素） */
  minScreenGap: number;
}

/** 计算结果的来源：让界面能说明「为什么显示的是这个密度」 */
export type GridReason = "auto" | "user" | "too-dense";

/** 实际采用的网格参数 */
export interface GridPlan {
  /** 实际度数 */
  intervalDeg: GridInterval;
  /** 相邻经线的屏幕间距（像素） */
  lonGapPx: number;
  /** 赤道附近相邻纬线的屏幕间距（像素） */
  latGapPx: number;
  /** 用户档位被自动降级的原因 */
  reason: GridReason;
}

/**
 * 取经线在屏幕上的基准间距（单位：像素 / 度）。
 *
 * 等距圆柱投影下经度是等比展开的：360° 对应整个白板宽度。
 *
 * @param context 计算上下文
 * @returns 每度对应的屏幕像素
 */
function lonPixelsPerDegree(context: GridContext): number {
  return (context.boardWidth / 360) * context.zoom;
}

/**
 * 取纬线在屏幕上的基准间距（单位：像素 / 度）。
 *
 * 纬度同样是等比的：180° 对应整个白板高度。
 *
 * @param context 计算上下文
 * @returns 每度对应的屏幕像素
 */
function latPixelsPerDegree(context: GridContext): number {
  return (context.boardHeight / 180) * context.zoom;
}

/**
 * 判断某个档位在当前缩放下是否已经太密。
 *
 * 经线与纬线都要满足下限：只要有一边糊了，这个档位就不能用。
 *
 * @param intervalDeg 档位度数
 * @param context 计算上下文
 * @returns 是否太密
 */
function isTooDense(intervalDeg: number, context: GridContext): boolean {
  const lonGap = intervalDeg * lonPixelsPerDegree(context);
  const latGap = intervalDeg * latPixelsPerDegree(context);
  const gap = Math.min(lonGap, latGap);
  return gap < context.minScreenGap;
}

/**
 * 决定这次实际要用的网格密度。
 *
 * @param context 计算上下文
 * @returns 实际度数、屏幕间距与原因
 */
export function planGrid(context: GridContext): GridPlan {
  const { choice } = context;
  let intervalDeg: number;
  let reason: GridReason;

  if (choice === GRID_AUTO) {
    // 自动：从最细往粗找，取第一个不糊的档位
    intervalDeg = GRID_INTERVALS_DEG[GRID_INTERVALS_DEG.length - 1] as number;
    reason = "auto";
    for (let index = GRID_INTERVALS_DEG.length - 1; index >= 0; index -= 1) {
      const candidate = GRID_INTERVALS_DEG[index] as number;
      if (!isTooDense(candidate, context)) {
        intervalDeg = candidate;
        break;
      }
    }
    // 全都不满足（缩得极小）：用最粗的那档
    if (isTooDense(intervalDeg, context)) {
      intervalDeg = GRID_INTERVALS_DEG[0] as number;
    }
  } else {
    intervalDeg = choice;
    reason = "user";
    // 用户选的档位在缩小视图后会糊：自动降级，但界面要说明
    if (isTooDense(intervalDeg, context)) {
      reason = "too-dense";
      const usable = GRID_INTERVALS_DEG.filter((item) => item >= intervalDeg && !isTooDense(item, context));
      intervalDeg = usable.length > 0 ? (usable[usable.length - 1] as number) : (GRID_INTERVALS_DEG[0] as number);
    }
  }

  return {
    intervalDeg: intervalDeg as GridInterval,
    lonGapPx: intervalDeg * lonPixelsPerDegree(context),
    latGapPx: intervalDeg * latPixelsPerDegree(context),
    reason,
  };
}

/**
 * 在档位表里取「下一个」档位，供工具栏按钮循环切换。
 *
 * 顺序是 自动 → 30 → 15 → 10 → 5 → 2 → 1 → 自动，
 * 也就是「越点越细，到底后回到自动」。
 *
 * @param choice 当前档位
 * @returns 下一个档位
 */
export function nextGridChoice(choice: GridIntervalChoice): GridIntervalChoice {
  if (choice === GRID_AUTO) {
    return GRID_INTERVALS_DEG[0] as number;
  }
  const index = GRID_INTERVALS_DEG.indexOf(choice as GridInterval);
  if (index < 0) {
    return GRID_AUTO;
  }
  if (index >= GRID_INTERVALS_DEG.length - 1) {
    return GRID_AUTO;
  }
  return GRID_INTERVALS_DEG[index + 1] as number;
}

/**
 * 档位的显示名称。
 * @param choice 档位
 * @returns 界面上显示的文字
 */
export function gridChoiceLabel(choice: GridIntervalChoice): string {
  return choice === GRID_AUTO ? "自动" : `${choice}°`;
}
