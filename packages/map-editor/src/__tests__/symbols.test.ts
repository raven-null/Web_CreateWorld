/**
 * 装饰符号（古地图素材 ↔ 简洁现代程序化绘制）的**纯逻辑测试**。
 *
 * ⚠️ 这些测试跑在 node 里，**没有 DOM / 没有 Canvas / 没有 `Path2D`**。
 * 这不是将就，而是刻意保留的一条底线：素材缺失或环境不支持时，
 * `drawDecorationSymbol()` 必须返回 false 让调用方回退，**绝不能抛错**——
 * 抛错会让整幅手绘位图烘不出来（用户看到的是空白地图）。
 *
 * 视觉观感（符号大小、线条粗细、四种装饰各自选哪个素材）必须在浏览器里看，
 * 这里只守住那些「肉眼查不出、但坏了就崩」的性质。
 */
import { describe, expect, it } from "vitest";
import { ANTIQUE_DECORATION_SYMBOLS } from "../terrain-style";
import { decorationSymbol, drawDecorationSymbol } from "../symbols";
import { ANTIQUE_SYMBOLS } from "../symbols-antique";

/** 四种装饰类型（与 `DecorationKind` 一致；这里写死是为了「新增种类时会失败提醒」） */
const DECORATION_KINDS = ["peak", "tree", "wave", "dune"] as const;

describe("没有 Path2D 的环境（node / 测试 / 极简宿主）", () => {
  it("确认本环境真的没有 Path2D（否则下面两条测试就失去意义）", () => {
    expect(typeof Path2D).toBe("undefined");
  });

  it("drawDecorationSymbol 安全返回 false，不抛异常", () => {
    // 上下文传 undefined：因为本环境第一步就返回 false，根本走不到绘制
    const context = undefined as unknown as CanvasRenderingContext2D;
    for (const kind of DECORATION_KINDS) {
      expect(() => drawDecorationSymbol(context, "antique", kind, 10, 10, 16, "#4a3b28")).not.toThrow();
      expect(drawDecorationSymbol(context, "antique", kind, 10, 10, 16, "#4a3b28")).toBe(false);
    }
  });

  it("context 为 null 也安全（宿主画布拿不到 2d 上下文时的极端情况）", () => {
    const context = null as unknown as CanvasRenderingContext2D;
    expect(drawDecorationSymbol(context, "antique", "peak", 0, 0, 16, "#000000")).toBe(false);
  });
});

describe("画风分派", () => {
  it("modern 画风返回 null（调用方据此走程序化绘制）", () => {
    for (const kind of DECORATION_KINDS) {
      expect(decorationSymbol("modern", kind, "#4a3b28")).toBeNull();
    }
  });

  it("antique 画风在本环境也返回 null：没有 Canvas 就造不出符号画布", () => {
    // 关键点是「返回 null 而不是抛错」——抛错会中断整幅烘焙
    for (const kind of DECORATION_KINDS) {
      expect(() => decorationSymbol("antique", kind, "#4a3b28")).not.toThrow();
      expect(decorationSymbol("antique", kind, "#4a3b28")).toBeNull();
    }
  });
});

describe("装饰类型 → 素材序号的映射", () => {
  it("每个装饰类型都配了素材序号（新增装饰类型时会在这里失败）", () => {
    for (const kind of DECORATION_KINDS) {
      expect(typeof ANTIQUE_DECORATION_SYMBOLS[kind]).toBe("number");
    }
    expect(Object.keys(ANTIQUE_DECORATION_SYMBOLS).length).toBe(DECORATION_KINDS.length);
  });

  it("配置的序号在 ANTIQUE_SYMBOLS 里都找得到（否则该地形永远没有符号）", () => {
    for (const kind of DECORATION_KINDS) {
      const index = ANTIQUE_DECORATION_SYMBOLS[kind];
      const symbol = ANTIQUE_SYMBOLS.find((item) => item.sourceIndex === index);
      expect(symbol, `装饰 ${kind} 配的素材序号 ${index} 在素材表里不存在`).toBeDefined();
    }
  });

  it("四种装饰用的是不同的素材（否则换了画风却看不出区别）", () => {
    const used = DECORATION_KINDS.map((kind) => ANTIQUE_DECORATION_SYMBOLS[kind]);
    expect(new Set(used).size).toBe(used.length);
  });

  it("sourceIndex 不重复（重复会让 find 取到另一个符号，观感对不上）", () => {
    const indexes = ANTIQUE_SYMBOLS.map((symbol) => symbol.sourceIndex);
    expect(new Set(indexes).size).toBe(indexes.length);
  });
});

describe("素材数据本身是完整的", () => {
  it("拆出来的符号都有名字、序号合法、至少一条路径", () => {
    expect(ANTIQUE_SYMBOLS.length).toBeGreaterThan(0);
    for (const symbol of ANTIQUE_SYMBOLS) {
      expect(symbol.name.length).toBeGreaterThan(0);
      expect(symbol.sourceIndex).toBeGreaterThanOrEqual(0);
      expect(symbol.paths.length).toBeGreaterThan(0);
    }
  });

  it("每条路径的 d 都以 M 开头（Path2D 能解析的前提）、描边宽度为正", () => {
    for (const symbol of ANTIQUE_SYMBOLS) {
      for (const path of symbol.paths) {
        expect(path.d.length).toBeGreaterThan(0);
        expect(path.d.trimStart().startsWith("M")).toBe(true);
        expect(path.strokeWidth).toBeGreaterThan(0);
      }
    }
  });
});
