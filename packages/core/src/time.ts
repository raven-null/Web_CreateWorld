import type { TimeGranularity, TimeNumberStyle } from "./types";

/** 中文数字字符（按位读法，虚构纪年常用） */
const CHINESE_DIGITS = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/**
 * 整数转中文数字（按位读法，如 402 → 四〇二；负数加「前」前缀）。
 * @param value 整数
 * @returns 中文数字字符串
 */
export function toChineseNumber(value: number): string {
  const negative = value < 0;
  const digits = String(Math.abs(Math.trunc(value)))
    .split("")
    .map((digit) => CHINESE_DIGITS[Number(digit)] ?? "")
    .join("");
  return negative ? `前${digits}` : digits;
}

/** 事件时间展示参数 */
export interface EventTimeOptions {
  eraName: string | null;
  year: number | null;
  month: number | null;
  day: number | null;
  season: string;
  timeUndetermined: boolean;
  granularity: TimeGranularity;
  numberStyle: TimeNumberStyle;
}

/**
 * 格式化时间线事件的时间文案（前端展示与服务端导出共用）。
 * @param options 事件时间参数
 * @returns 如「第三纪元 402 年 春」；时间未定返回「时间未定」
 */
export function formatEventTime(options: EventTimeOptions): string {
  if (options.timeUndetermined || options.year === null) {
    return "时间未定";
  }

  /** 按数字风格输出数字文本 */
  const formatNumber = (value: number): string =>
    options.numberStyle === "chinese" ? toChineseNumber(value) : String(value);

  const parts: string[] = [];
  if (options.eraName) {
    parts.push(options.eraName);
  }
  parts.push(`${formatNumber(options.year)} 年`);
  if (options.granularity !== "year" && options.month !== null) {
    parts.push(`${formatNumber(options.month)} 月`);
  }
  if (options.granularity === "day" && options.day !== null) {
    parts.push(`${formatNumber(options.day)} 日`);
  }
  if (options.season) {
    parts.push(options.season);
  }
  return parts.join(" ");
}
