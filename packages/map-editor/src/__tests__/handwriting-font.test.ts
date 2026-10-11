/**
 * 地名手写体（字体栈 / 按需加载 / 降级）的回归测试。
 *
 * 为什么只测字体栈这一半：加载那一半需要真实浏览器的 `FontFace` + `document.fonts`，
 * 在无 DOM 的测试环境里只能靠桩，桩测出来的"能加载"没有说服力。
 * 因此把**决策逻辑**（栈怎么拼、状态怎么算）抽成纯函数测掉，
 * 把网络/超时行为留给 `ensureHandwritingFont()` 的注释说明：
 * 它的三条纪律是「只在开启时加载」「成功才置 ready」「失败或超时一律 fallback，绝不抛错」。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME } from "../theme";
import { labelFont } from "../terrain-render";
import {
  DEFAULT_HANDWRITING_TIMEOUT_MS,
  HANDWRITING_FONT_FAMILY,
  buildFontSpec,
  handwritingFontLoaded,
  resetHandwritingFont,
  resolveFontStack,
  resolveHandwritingStack,
} from "../handwriting-font";

describe("字体栈拼接", () => {
  it("带空格的族名自动加引号，并补上通用兜底族", () => {
    expect(resolveFontStack(["Kaiti SC", "sans-serif"])).toBe('"Kaiti SC", sans-serif');
    expect(resolveFontStack(["KaiTi"])).toBe("KaiTi, serif");
  });

  it("去掉空项与重复引号，避免整串 font 规格解析失败", () => {
    expect(resolveFontStack(["  ", '"Kaiti SC"', ""], "sans-serif")).toBe('"Kaiti SC", sans-serif');
  });

  it("默认主题自带系统楷体栈，零下载就有手写观感", () => {
    expect(DEFAULT_THEME.fontHand).toContain("Kaiti SC");
    expect(DEFAULT_THEME.fontHand).toContain("KaiTi");
    // 不含任何自带字体族名：默认不加载任何字体文件
    expect(DEFAULT_THEME.fontHand).not.toContain(HANDWRITING_FONT_FAMILY);
  });

  it("未加载自带字体时，手写栈就是系统楷体栈（完整可用，调用方无需判空）", () => {
    resetHandwritingFont();
    expect(handwritingFontLoaded()).toBe(false);
    const stack = resolveHandwritingStack(DEFAULT_THEME.fontHand);
    expect(stack).toContain("Kaiti SC");
    expect(stack).toContain("serif");
    expect(stack).not.toContain(HANDWRITING_FONT_FAMILY);
  });
});

describe("画布字体规格", () => {
  it("拼出合法的 context.font 规格（字号取整、字重可覆盖）", () => {
    resetHandwritingFont();
    expect(buildFontSpec(12, '"Kaiti SC", serif')).toBe('normal 12px "Kaiti SC", serif');
    expect(buildFontSpec(11.6, "serif", "bold")).toBe("bold 12px serif");
  });

  it("字号非法时退回 12px：非法规格会让画布静默用默认字体，很难查", () => {
    expect(buildFontSpec(0, "serif")).toBe("normal 12px serif");
    expect(buildFontSpec(Number.NaN, "serif")).toBe("normal 12px serif");
    expect(buildFontSpec(14, "serif", "   ")).toBe("normal 14px serif");
  });

  it("labelFont：开启手写时用楷体栈，关闭时用无衬线栈", () => {
    resetHandwritingFont();
    const hand = labelFont(12, true, DEFAULT_THEME.fontHand, DEFAULT_THEME.fontSans);
    const plain = labelFont(12, false, DEFAULT_THEME.fontHand, DEFAULT_THEME.fontSans);
    expect(hand).toContain("Kaiti SC");
    expect(plain).not.toContain("Kaiti SC");
    expect(plain).toContain("Source Han Sans SC");
  });

  it("默认超时是有限的：加载失败必须能自己降级，而不是永远转圈", () => {
    expect(DEFAULT_HANDWRITING_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_HANDWRITING_TIMEOUT_MS).toBeLessThanOrEqual(15000);
  });
});
