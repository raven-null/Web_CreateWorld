/**
 * 白板改尺寸：把索引栅格重采样到新的宽高（方案 §5.6.2）。
 *
 * 关键决策：**只能用最近邻（Nearest Neighbor）**。
 * 调色板索引图只有 8 位，双线性插值会算出「调色板里不存在的中间色」，
 * 反而把数据弄脏；最近邻能保证结果仍然是合法的调色板下标。
 *
 * 无损性（要在界面上告诉用户）：
 * - ×2 的整数幂缩放（2048↔4096）完全无损：每格 1×1 或 2×2 对齐
 * - 其它整数倍缩放基本无损，只有轻微几何错位
 * - 非整数倍放大无损但**不新增信息**（锯齿只是变明显）
 * - 非整数倍缩小**会丢细节**（细河流、小岛可能消失），必须明确警告
 */
import type { BoardSpec } from "@worldmap/core";

/** 白板宽度约束（与服务端一致） */
export const BOARD_MIN_WIDTH = 512;
export const BOARD_MAX_WIDTH = 16384;
export const BOARD_WIDTH_STEP = 128;

/** 重采样结果 */
export interface ResampleResult {
  indices: Uint8Array;
  width: number;
  height: number;
}

/**
 * 把宽度规整为合法值：向上取整到 128 的倍数并夹在范围内。
 * @param raw 用户输入
 * @returns 规整后的宽度
 */
export function normalizeBoardWidth(raw: number): number {
  const value = Number.isFinite(raw) ? raw : 2048;
  const stepped = Math.ceil(value / BOARD_WIDTH_STEP) * BOARD_WIDTH_STEP;
  return Math.min(Math.max(stepped, BOARD_MIN_WIDTH), BOARD_MAX_WIDTH);
}

/**
 * 判断放大是否为「像素无损」：结果是整数倍（每格复制成 k×k）。
 *
 * 注意方向性：
 * - **放大且为整数倍 → 无损**（k=2 时每格变 2×2，反复放大缩小可逆）
 * - **缩小 → 一定有损**：目标格要覆盖多格原像素，只能取一个代表值，
 *   细河流、小岛这类细节必然可能消失（这一条曾被实现成「×2 幂即无损」，
 *   被单元测试逮出来）
 *
 * @param fromWidth 原宽
 * @param toWidth 新宽
 * @returns 无损返回 true
 */
export function isLosslessResize(fromWidth: number, toWidth: number): boolean {
  if (toWidth < fromWidth) {
    return false;
  }
  if (toWidth === fromWidth) {
    return true;
  }
  return Number.isInteger(toWidth / fromWidth);
}

/**
 * 用最近邻把索引栅格缩放到新尺寸。
 *
 * 放大时整块复制原格；缩小时按目标格覆盖区域的**中心格**取值
 * （避免出现孤立错误色点；真正的众数投票留给后续优化）。
 *
 * @param indices 原全幅栅格（行优先）
 * @param fromWidth 原宽
 * @param fromHeight 原高
 * @param toWidth 新宽
 * @param toHeight 新高
 * @returns 新的索引栅格
 */
export function resampleNearest(
  indices: Uint8Array,
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
): Uint8Array {
  if (fromWidth === toWidth && fromHeight === toHeight) {
    return new Uint8Array(indices);
  }
  const out = new Uint8Array(toWidth * toHeight);
  const scaleX = fromWidth / toWidth;
  const scaleY = fromHeight / toHeight;

  for (let y = 0; y < toHeight; y += 1) {
    // 取覆盖区域的中心（+0.5 是像素中心约定）
    const sourceY = Math.min(fromHeight - 1, Math.floor((y + 0.5) * scaleY));
    const sourceRowStart = sourceY * fromWidth;
    const targetRowStart = y * toWidth;
    for (let x = 0; x < toWidth; x += 1) {
      const sourceX = Math.min(fromWidth - 1, Math.floor((x + 0.5) * scaleX));
      out[targetRowStart + x] = indices[sourceRowStart + sourceX] ?? 0;
    }
  }
  return out;
}

/**
 * 估算改尺寸后的数据量变化倍数（用于界面提示）。
 * @param fromWidth 原宽
 * @param toWidth 新宽
 * @returns 倍数（面积比，因为瓦片数是按面积走的）
 */
export function dataSizeRatio(fromWidth: number, toWidth: number): number {
  const ratio = toWidth / fromWidth;
  return ratio * ratio;
}

/**
 * 生成改尺寸前给用户看的说明文字。
 * @param fromBoard 原白板
 * @param toWidth 新宽度（未规整）
 * @returns 提示文案与风险等级
 */
export function describeResize(
  fromBoard: BoardSpec,
  toWidth: number,
): { message: string; level: "info" | "warn"; normalizedWidth: number } {
  const normalized = normalizeBoardWidth(toWidth);
  const ratio = normalized / fromBoard.width;
  const sizeRatio = dataSizeRatio(fromBoard.width, normalized);
  const sizeText = `数据量约 ×${sizeRatio.toFixed(2)}`;

  if (normalized === fromBoard.width) {
    return { message: "宽度未变化", level: "info", normalizedWidth: normalized };
  }
  if (isLosslessResize(fromBoard.width, normalized)) {
    const times = normalized / fromBoard.width;
    return {
      message: `整数倍放大 ×${times}：**无损**，每格精确复制成 ${times}×${times}（${sizeText}）`,
      level: "info",
      normalizedWidth: normalized,
    };
  }
  if (ratio > 1) {
    return {
      message: `放大 ${ratio.toFixed(2)} 倍：不会新增细节，只是把像素放大（锯齿会更明显）；${sizeText}`,
      level: "info",
      normalizedWidth: normalized,
    };
  }
  return {
    message: `缩小到 ${(ratio * 100).toFixed(0)}%：**会丢细节**（细小的河流、岛屿可能消失），请确认；${sizeText}`,
    level: "warn",
    normalizedWidth: normalized,
  };
}
