/**
 * 预览工具栏图标，确认每个图标的形状是否与功能相符。
 *
 * 图标是内联矢量路径（见 `src/toolbar-icons.ts`），画错了一眼看不出——
 * 这个脚本把它们按不同尺寸画出来，便于逐一核对。
 *
 * 用法：node scripts/preview-toolbar-icons.mjs
 * 输出：`.tmp-toolbar-icons.png`
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const require = createRequire(join(root, "node_modules/.pnpm/node_modules/"));
const sharp = (await import("file:///" + require.resolve("sharp").replace(/\\/g, "/"))).default;

// 直接从源码里取图标表，避免为了一个预览脚本引入 TS 构建
const source = readFileSync(join(root, "packages/map-editor/src/toolbar-icons.ts"), "utf8");
const block = /export const TOOL_ICONS: Record<ToolIconName, string> = \{([\s\S]*?)\n\};/.exec(source);
if (!block) {
  throw new Error("没找到 TOOL_ICONS（源码结构可能变了）");
}
const icons = [...block[1].matchAll(/^\s{2}(\w+): "([^"]+)",/gm)].map((m) => ({ name: m[1], d: m[2] }));
console.log(`图标数: ${icons.length}`);

/** 每个图标画三种尺寸，模拟工具栏实际显示大小 */
const SIZES = [16, 24, 40];
const COL_W = 150;
const ROW_H = 74;

const parts = [];
for (const [row, icon] of icons.entries()) {
  const y = row * ROW_H;
  parts.push(
    `<text x="8" y="${y + 45}" font-family="Consolas, monospace" font-size="20" fill="#333" text-anchor="start">${icon.name}</text>`,
  );
  for (const [col, size] of SIZES.entries()) {
    const x = 190 + col * COL_W;
    const scale = size / 24;
    const offsetY = y + (ROW_H - size) / 2;
    // 深色底（工具栏）+ 浅色线，与真实使用环境一致
    parts.push(
      `<rect x="${x - 6}" y="${offsetY - 6}" width="${size + 12}" height="${size + 12}" rx="4" fill="#1c1915"/>`,
    );
    parts.push(
      `<g transform="translate(${x} ${offsetY}) scale(${scale.toFixed(4)})" fill="none" stroke="#e8e0d3" ` +
        `stroke-width="${(1.6 / scale).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="${icon.d}"/></g>`,
    );
  }
}

const width = 190 + SIZES.length * COL_W;
const height = icons.length * ROW_H + 12;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#f2efe9"/>${parts.join("")}</svg>`;

const out = join(root, ".tmp-toolbar-icons.png");
await sharp(Buffer.from(svg), { density: 96 }).png().toFile(out);
console.log(`图标预览已生成：${out}（${width}×${height}）`);
