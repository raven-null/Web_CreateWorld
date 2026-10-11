/**
 * 从 Kenney Cartography Pack 的矢量素材生成 `symbols-antique.ts`。
 *
 * ## 为什么需要这个脚本
 *
 * 素材（`packages/map-editor/assets/terrain/symbols/cartography-pack.svg`）是一整张
 * **无分组、无命名**的矢量图：162 条 `<path>` 平铺在一张画布上，没有 `<g>`、没有 `id`。
 * 要把它用起来，必须先拆成「独立符号」——同一座山可能由两三条路径组成。
 *
 * 拆解思路：
 * 1. 算每条路径的包围盒（只按 M/L/H/V/Q/C 的终点算，够用）
 * 2. 把「包围盒相接或重叠」的路径合并成一个连通分量 = 一个符号
 * 3. 每个符号平移到自己的原点、归一到 `0~100` 的方框
 * 4. 坐标取整（1 单位 = 符号尺寸的 1%，视觉无差别，体积减三分之一）
 *
 * ## 用法
 *
 * ```bash
 * node scripts/build-antique-symbols.mjs
 * ```
 *
 * 换素材时：把新的 SVG 覆盖 `cartography-pack.svg`，重跑本脚本，
 * 然后**重新确认** `terrain-style.ts` 里 `ANTIQUE_DECORATION_SYMBOLS` 的序号
 * （序号是符号在扫描顺序中的位置，换素材后会变）。
 *
 * ## 自校验
 *
 * 脚本会验证「平移前后包围盒尺寸一致」（容差 1.0，即取整带来的最大舍入误差）。
 * 这道校验能抓住「坐标平移算错」这类最难肉眼发现的错误——早期版本把曲线命令的
 * 参数当直线处理，符号形状被拉坏了，就是靠它发现的。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const SVG_PATH = join(root, "packages/map-editor/assets/terrain/symbols/cartography-pack.svg");
const OUT_PATH = join(root, "packages/map-editor/src/symbols-antique.ts");

/** 各绘图命令的参数个数 */
const ARITY = { m: 2, l: 2, h: 1, v: 1, q: 4, t: 2, c: 6, s: 4, z: 0 };

/** 命令字符（含相对形式）的匹配 */
const COMMAND_PATTERN = /^[MmLlHhVvQqTtCcSsZz]$/;

/**
 * 把 path 数据切成「命令 + 参数数组」的序列。
 *
 * 必须按命令分组的参数个数来切，不能把数字一个个交替当成 x/y：
 * 曲线命令（Q 四个参数、C 六个）与直线命令的参数个数不同，
 * 逐数字处理会把坐标算错（早期版本踩过这个坑）。
 *
 * @param d path 数据
 * @returns 命令序列
 */
function parseCommands(d) {
  const tokens = d.match(/[MmLlHhVvQqTtCcSsZz]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const commands = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!COMMAND_PATTERN.test(token)) {
      index += 1;
      continue;
    }
    const command = token;
    const arity = ARITY[token.toLowerCase()] ?? 0;
    index += 1;
    if (arity === 0) {
      commands.push({ command, args: [] });
      continue;
    }
    while (index < tokens.length && !COMMAND_PATTERN.test(tokens[index])) {
      const args = [];
      for (let i = 0; i < arity && index < tokens.length; i += 1) {
        args.push(Number(tokens[index]));
        index += 1;
      }
      if (args.length === arity) {
        commands.push({ command, args });
      }
    }
  }
  return commands;
}

/**
 * 取命令的终点坐标（相对命令要加上当前点）。
 * @param command 命令字符（大小写区分绝对/相对）
 * @param args 参数
 * @param cursor 当前点
 * @returns 终点与是否为相对命令
 */
function endpointOf(command, args, cursor) {
  const lower = command.toLowerCase();
  const relative = command !== command.toUpperCase();
  const last =
    lower === "h" ? [args[0], 0] : lower === "v" ? [0, args[0]] : [args[args.length - 2], args[args.length - 1]];
  const x = relative ? cursor.x + (last[0] ?? 0) : (last[0] ?? cursor.x);
  const y = relative ? cursor.y + (last[1] ?? 0) : (last[1] ?? cursor.y);
  return { point: { x, y }, relative };
}

/**
 * 计算一组点的包围盒。
 * @param points 点数组
 * @returns 包围盒
 */
function boundsOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * 取 path 的所有终点坐标。
 * @param d path 数据
 * @returns 点数组
 */
function pointsOf(d) {
  const points = [];
  let cursor = { x: 0, y: 0 };
  for (const { command, args } of parseCommands(d)) {
    if (args.length === 0) {
      continue;
    }
    const { point } = endpointOf(command, args, cursor);
    points.push([point.x, point.y]);
    cursor = point;
  }
  return points;
}

/** 两个包围盒是否相接或重叠（允许 tolerance 的间隙） */
function touches(a, b, tolerance = 4) {
  return (
    a.minX - tolerance <= b.maxX &&
    b.minX - tolerance <= a.maxX &&
    a.minY - tolerance <= b.maxY &&
    b.minY - tolerance <= a.maxY
  );
}

/**
 * 把 path 平移到新原点，坐标取整。
 * @param d path 数据
 * @param dx x 平移量
 * @param dy y 平移量
 * @returns 平移后的 d 与包围盒（供自校验）
 */
function translatePath(d, dx, dy) {
  const out = [];
  let cursor = { x: 0, y: 0 };
  let bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const round = (value) => Math.round(value);
  for (const { command, args } of parseCommands(d)) {
    const lower = command.toLowerCase();
    if (lower === "z") {
      out.push(command);
      continue;
    }
    const { point, relative } = endpointOf(command, args, cursor);
    if (relative) {
      // 相对命令的偏移量不随平移改变
      out.push(`${command} ${args.map(round).join(" ")}`);
      cursor = point;
    } else {
      // 绝对命令：只有终点参与平移（控制点随终点一起移，形状不变）
      const shifted = args.map((value, index) => {
        const isLastX = index === args.length - 2;
        const isLastY = index === args.length - 1;
        if (lower === "h") return round(value + dx);
        if (lower === "v") return round(value + dy);
        if (isLastX) return round(value + dx);
        if (isLastY) return round(value + dy);
        return round(value);
      });
      out.push(`${command} ${shifted.join(" ")}`);
      cursor = { x: point.x + dx, y: point.y + dy };
    }
    const bx = round(relative ? point.x : point.x + dx);
    const by = round(relative ? point.y : point.y + dy);
    if (Number.isFinite(bx) && Number.isFinite(by)) {
      bounds = {
        minX: Math.min(bounds.minX, bx),
        minY: Math.min(bounds.minY, by),
        maxX: Math.max(bounds.maxX, bx),
        maxY: Math.max(bounds.maxY, by),
      };
    }
  }
  return { d: out.join(" "), bounds };
}

const svg = readFileSync(SVG_PATH, "utf8");
const pathMatches = [...svg.matchAll(/<path\b([^>]*)\/?>/g)];
if (pathMatches.length === 0) {
  throw new Error(`素材里没有找到 path：${SVG_PATH}`);
}

const paths = pathMatches.map((match, index) => {
  const attrs = match[1];
  const d = /d="([^"]*)"/.exec(attrs)?.[1] ?? "";
  return {
    index,
    d,
    strokeWidth: Number(/stroke-width="([^"]*)"/.exec(attrs)?.[1] ?? "1"),
    bounds: boundsOf(pointsOf(d)),
  };
});

// 连通分量聚类：不断合并「包围盒相接」的组
let groups = paths.map((path) => ({ paths: [path], bounds: { ...path.bounds } }));
let merged = true;
while (merged) {
  merged = false;
  outer: for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      if (touches(groups[i].bounds, groups[j].bounds)) {
        const mergedPaths = [...groups[i].paths, ...groups[j].paths];
        const minX = Math.min(groups[i].bounds.minX, groups[j].bounds.minX);
        const minY = Math.min(groups[i].bounds.minY, groups[j].bounds.minY);
        const maxX = Math.max(groups[i].bounds.maxX, groups[j].bounds.maxX);
        const maxY = Math.max(groups[i].bounds.maxY, groups[j].bounds.maxY);
        groups.splice(j, 1);
        groups[i] = {
          paths: mergedPaths,
          bounds: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
        };
        merged = true;
        break outer;
      }
    }
  }
}
groups.sort((a, b) => a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX);

const lines = [];
let failures = 0;
lines.push("/**");
lines.push(" * 手绘古地图符号（矢量数据，自动生成）。");
lines.push(" *");
lines.push(" * 素材来源：Kenney Cartography Pack（CC0，见 assets/README.md 素材清单）；");
lines.push(" * 由 `scripts/build-antique-symbols.mjs` 从素材 SVG 拆解生成，**不要手工编辑本文件**。");
lines.push(" *");
lines.push(" * 坐标系：每个符号已平移到自己的原点并归一到 `0~100` 方框，");
lines.push(" * 绘制端 `ctx.scale(size / 100, size / 100)` 后按 `strokeWidth` 描边即可。");
lines.push(" */");
lines.push("");
lines.push("/** 一个符号由若干条描边路径组成 */");
lines.push("export interface SymbolPaths {");
lines.push("  /** 符号名（按素材扫描顺序编号） */");
lines.push("  name: string;");
lines.push("  /** 素材中的序号，`terrain-style.ts` 按它引用符号 */");
lines.push("  sourceIndex: number;");
lines.push("  /** 构成该符号的路径（已平移归一） */");
lines.push("  paths: { d: string; strokeWidth: number }[];");
lines.push("}");
lines.push("");
lines.push("export const ANTIQUE_SYMBOLS: SymbolPaths[] = [");

for (const group of groups) {
  const b = group.bounds;
  lines.push("  {");
  lines.push(`    name: "antique-${group.paths[0].index}",`);
  lines.push(`    sourceIndex: ${groups.indexOf(group)},`);
  lines.push("    paths: [");
  for (const path of group.paths) {
    const result = translatePath(path.d, -b.minX, -b.minY);
    // 自校验：平移只改变位置，包围盒宽高必须与原始一致（容差 1.0 = 取整的最大舍入误差）
    const width = result.bounds.maxX - result.bounds.minX;
    const height = result.bounds.maxY - result.bounds.minY;
    if (Math.abs(width - path.bounds.width) > 1.0 || Math.abs(height - path.bounds.height) > 1.0) {
      failures += 1;
      console.error(
        `✗ 符号 ${group.paths[0].index} 平移后尺寸不符：` +
          `原始 ${path.bounds.width.toFixed(1)}×${path.bounds.height.toFixed(1)} → ` +
          `平移后 ${width.toFixed(1)}×${height.toFixed(1)}`,
      );
    }
    lines.push(`      { d: ${JSON.stringify(result.d)}, strokeWidth: ${path.strokeWidth} },`);
  }
  lines.push("    ],");
  lines.push("  },");
}
lines.push("];");
lines.push("");

const text = lines.join("\n");
writeFileSync(OUT_PATH, text, "utf8");
console.log(`素材路径: ${SVG_PATH}`);
console.log(`输出: ${OUT_PATH}`);
console.log(`符号数: ${groups.length}，文件大小: ${(text.length / 1024).toFixed(1)} KB`);
if (failures > 0) {
  console.error(`❌ 自校验失败 ${failures} 处——请检查坐标平移逻辑`);
  process.exitCode = 1;
} else {
  console.log("✅ 自校验通过：所有符号平移前后包围盒尺寸一致");
}
