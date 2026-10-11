/**
 * 放大渲染指定序号的手绘符号，用于人工确认「这个编号是什么符号」。
 *
 * 用途：`terrain-style.ts` 里的 `ANTIQUE_DECORATION_SYMBOLS` 按序号引用素材符号，
 * 换素材或调整映射时，用它把候选符号放大看清楚，再决定用哪个。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/preview-antique-symbols.mjs 44 40 18 39
 * ```
 *
 * 输出 `.tmp-symbol-preview.png`（仓库根目录，已在 .gitignore 里）。
 * 序号从 0 开始，共 68 个符号。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const require = createRequire(join(root, "node_modules/.pnpm/node_modules/"));
const sharp = (await import("file:///" + require.resolve("sharp").replace(/\\/g, "/"))).default;

const ids = process.argv.slice(2).map(Number);
if (ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
  console.error("用法：node scripts/preview-antique-symbols.mjs <序号> [序号...]");
  console.error("例如：node scripts/preview-antique-symbols.mjs 44 40 18 39");
  process.exit(1);
}

const source = readFileSync(join(root, "packages/map-editor/src/symbols-antique.ts"), "utf8");
const CELL = 340;
const COLUMNS = Math.min(3, ids.length);

const parts = [];
for (const [i, id] of ids.entries()) {
  const match = new RegExp(`sourceIndex: ${id},\\s*paths: \\[([\\s\\S]*?)\\n    \\],`).exec(source);
  if (!match) {
    console.error(`找不到符号 #${id}（序号应在 0~67 之间）`);
    continue;
  }
  const paths = [...match[1].matchAll(/\{ d: ("(?:[^"\\]|\\.)*"), strokeWidth: ([\d.]+) \}/g)].map((item) => ({
    d: JSON.parse(item[1]),
    strokeWidth: Number(item[2]),
  }));

  const column = i % COLUMNS;
  const row = Math.floor(i / COLUMNS);
  const x = column * CELL;
  const y = row * CELL;
  const size = CELL - 80;
  const inner = paths.map((path) => `<path d="${path.d}" stroke-width="${path.strokeWidth}"/>`).join("");
  parts.push(
    `<g transform="translate(${x + 40} ${y + 30}) scale(${(size / 100).toFixed(4)})" fill="none" stroke="#222" ` +
      `stroke-linecap="round" stroke-linejoin="round">${inner}</g>`,
  );
  parts.push(
    `<text x="${x + CELL / 2}" y="${y + CELL - 12}" font-family="Arial" font-size="34" font-weight="bold" ` +
      `fill="#b3261e" text-anchor="middle">#${id}</text>`,
  );
}

const rows = Math.ceil(ids.length / COLUMNS);
const width = COLUMNS * CELL;
const height = rows * CELL;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#f7f4ee"/>${parts.join("")}</svg>`;

const out = join(root, ".tmp-symbol-preview.png");
await sharp(Buffer.from(svg), { density: 96 }).png().toFile(out);
console.log(`预览已生成：${out}（${width}×${height}）`);
