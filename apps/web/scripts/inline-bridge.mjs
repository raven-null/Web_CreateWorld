/**
 * 构建步骤：把同步桥（bridge.js）内联进 Weave 主页文件。
 *
 * 为什么需要这一步：
 *   1. bridge.js 是以 <script src> 方式外链的，Cloudflare 会按 URL 缓存它——改了内容但 URL 不变时，
 *      线上仍会拿到旧版本（实测命中过），排查会非常困惑；
 *   2. weave.html 每次构建都会变化（内容里带内联脚本），Cloudflare 会自动取新版本。
 *   因此把桥内联进 weave.html，既消除缓存问题，也不需要在 weave.html 里直接维护一大段桥代码
 *   （桥的源码仍然是可读可 lint 的独立文件）。
 *
 * 幂等：weave.html 里保留一段「内联占位」注释，重复执行只会替换两段注释之间的内容。
 * Weave 本体（内联在那一个 <script> 里的 7500 行）不做任何改动，桥脚本只以单独的 <script> 追加。
 *
 * 用法：node scripts/inline-bridge.mjs   （已挂在 @create-world/web 的 build 脚本里，构建时自动执行）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = resolve(HERE, "../public/weave/bridge.js");
const WEAVE_PATH = resolve(HERE, "../public/weave/weave.html");

const HEAD = "[>平台同步桥<]";
const INLINE_BEGIN = `/* ${HEAD} 由 scripts/inline-bridge.mjs 从 public/weave/bridge.js 内联，请勿直接编辑本段 */`;
const INLINE_END = `/* ${HEAD} 内联结束 */`;
const EXTERNAL_TAG = `<script src="./bridge.js"></script>`;
/** 外链标签上方那一行说明注释（首次注入时加的），内联后一并清掉 */
const EXTERNAL_NOTE = "<!-- 平台同步桥：见 apps/web/public/weave/bridge.js，负责与 React 画布页通信 -->";

const bridge = readFileSync(BRIDGE_PATH, "utf8");

let html = readFileSync(WEAVE_PATH, "utf8");

const beginIndex = html.indexOf(INLINE_BEGIN);
const endIndex = html.indexOf(INLINE_END);

if (beginIndex !== -1 && endIndex > beginIndex) {
  // 已有内联段：按位置整体替换（桥脚本自身含块注释，不能用注释符号猜边界）
  const segmentStart = beginIndex;
  const segmentEnd = endIndex + INLINE_END.length;
  html = `${html.slice(0, segmentStart)}${INLINE_BEGIN}\n${bridge.trimEnd()}\n${INLINE_END}${html.slice(segmentEnd)}`;
} else if (html.includes(EXTERNAL_TAG)) {
  // 首次构建：连同上方说明注释一起，把外链标签整体替换成内联段
  const inline = [
    "<!-- 平台同步桥：源码见 apps/web/public/weave/bridge.js，由 scripts/inline-bridge.mjs 内联（避免 CDN 缓存旧桥） -->",
    "<script>",
    INLINE_BEGIN,
    bridge.trimEnd(),
    INLINE_END,
    "</script>",
  ].join("\n");
  const withNote = `${EXTERNAL_NOTE}\n${EXTERNAL_TAG}`;
  html = html.includes(withNote)
    ? html.replace(withNote, inline)
    : html.replace(EXTERNAL_TAG, inline);
} else {
  throw new Error("weave.html 里既没有内联占位，也没有外链标签，请检查文件是否被改动");
}

// 清理可能残留的外链引用，避免浏览器重复加载桥脚本
if (html.includes(EXTERNAL_TAG)) {
  html = html.replace(`${EXTERNAL_NOTE}\n`, "").replace(EXTERNAL_TAG, "");
}

writeFileSync(WEAVE_PATH, Buffer.from(html, "utf8"));

// 自检：确认内联结果可读且幂等
const written = readFileSync(WEAVE_PATH, "utf8");
const ok =
  written.includes(INLINE_BEGIN) &&
  written.includes(INLINE_END) &&
  written.includes("weave:ready") &&
  !written.includes(EXTERNAL_TAG);
console.log(
  `[inline-bridge] 已内联 ${bridge.length} 字节桥代码 → weave.html ${written.length} 字符｜自检${ok ? "通过" : "失败"}`,
);
if (!ok) {
  throw new Error("内联后自检失败");
}
