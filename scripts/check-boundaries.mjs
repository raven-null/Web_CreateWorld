/**
 * 插件边界检查（CI 护栏）。
 *
 * 依据 docs/地图编辑器方案.md §15.1 的四条硬约束：
 *   1. 不 import 主站任何模块
 *   2. 不出现宿主业务概念（world / entry / invite …）
 *   3. 不直接 fetch 与 window.location：数据进出走 MapHostAdapter
 *   4. 不使用 React Context：所需状态一律从 props 传入
 *
 * 这四条决定了插件能否真正独立分发，也决定了将来补 Web Component 的成本，
 * 所以用脚本守住，而不是靠口头约定。
 *
 * 用法：node scripts/check-boundaries.mjs
 * 退出码：0 = 通过；1 = 存在违规
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 插件包目录（不含主站 packages/core，那是主站的共享包） */
const PACKAGE_DIRS = [
  "packages/map-core",
  "packages/map-editor",
  "packages/map-editor-web",
  "packages/map-element",
];

/** 只检查这些后缀的源文件 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];

/** 违规规则：命中即报错；`exceptPaths` 用于按层豁免（如平台实现层允许访问网络） */
const RULES = [
  {
    id: 1,
    name: "不得 import 主站模块",
    // 主站包名、主站前端源码、主站服务端路径
    pattern: /@create-world\/|apps\/(web|server)\/|src\/lib\/api/,
    hint: "插件必须自持类型与逻辑，宿主相关代码放在适配器实现里",
  },
  {
    id: 2,
    name: "不得出现宿主业务概念",
    // 业务标识与接口路径（worldmap 之类的中性包名不会命中）；
    // `\bentries\b(?!\s*\()` 排除标准库方法（Array/Map/Iterator 的 entries()）
    pattern: /\bworlds\b|worldId|world_id|\bentries\b(?!\s*\()|entryId|entry_id|inviteCode|invite_code|\/api\//,
    hint: "用 mapId / layerId / linkRef 这类中性标识代替",
    // 平台适配器实现层的职责就是「与宿主协议对话」，必须使用宿主的字段名
    // （协议翻译发生在这一层）；插件本体与内核仍是零业务概念
    exceptPaths: [/packages[\\/]map-editor-web[\\/]/],
  },
  {
    id: 3,
    name: "不得直接访问网络与地址栏",
    // 平台实现层（editor-web）本身就是「和外界打交道」的地方，允许它用 fetch；
    // 插件本体（editor / core）必须走 MapHostAdapter，所以不豁免
    pattern: /\bfetch\s*\(|XMLHttpRequest|window\.location|localStorage/,
    exceptPaths: [/packages[\\/]map-editor-web[\\/]/],
    hint: "数据进出必须走宿主实现的 MapHostAdapter（仅 platform 层允许直接访问网络）",
  },
  {
    id: 4,
    name: "不得使用 React Context",
    pattern: /\bcreateContext\b|\buseContext\b/,
    hint: "所需状态一律从 props 传入，否则将来无法包成任意框架可用的 Web Component",
  },
];

// 边界检查是"有没有耦合"，这些中性词允许出现（避免误报把规则变成噪音）
const ALLOWED_PATTERNS = [
  /@worldmap\//, // 自己人
  /entryRef/i, // 仅作为中性别名时才允许（当前已改为 linkRef）
];

/**
 * 递归收集目录下的源文件。
 * @param dir 起始目录
 * @returns 源文件绝对路径列表
 */
function collectSources(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // 目录尚未创建（如预留的 map-element），跳过
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSources(full));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * 去掉注释内容，避免把注释里提到的关键词当成违规
 * （注释中出现 `window` / `fetch` 这类词是在说明约束，不是真的调用）。
 * 跨行块注释的状态由调用方通过 `inBlock` 传入传出。
 * @param line 源码行
 * @param inBlock 该行开始时是否已处于块注释中
 * @returns 去掉注释后的代码部分与该行结束时的块注释状态
 */
function stripComment(line, inBlock) {
  let text = "";
  let index = 0;
  let block = inBlock;
  while (index < line.length) {
    if (block) {
      const end = line.indexOf("*/", index);
      if (end === -1) {
        return { code: text, inBlock: true };
      }
      block = false;
      index = end + 2;
      continue;
    }
    if (line.startsWith("/*", index)) {
      block = true;
      index += 2;
      continue;
    }
    if (line.startsWith("//", index)) {
      break;
    }
    text += line[index];
    index += 1;
  }
  return { code: text, inBlock: block };
}

/** 逐行检查单个文件，返回违规列表 */
function checkFile(file, violations) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let inBlock = false;
  for (const [index, line] of lines.entries()) {
    const stripped = stripComment(line, inBlock);
    inBlock = stripped.inBlock;
    const code = stripped.code.trim();
    if (!code) {
      continue;
    }
    if (ALLOWED_PATTERNS.some((allowed) => allowed.test(code))) {
      continue;
    }
    for (const rule of RULES) {
      // 按层豁免：如平台实现层允许直接访问网络
      if (rule.exceptPaths?.some((allowed) => allowed.test(file))) {
        continue;
      }
      if (rule.pattern.test(code)) {
        violations.push({
          rule,
          file,
          line: index + 1,
          text: code.slice(0, 120),
        });
      }
    }
  }
}

const violations = [];
let scanned = 0;
for (const pkgDir of PACKAGE_DIRS) {
  const sources = collectSources(pkgDir);
  scanned += sources.length;
  for (const file of sources) {
    checkFile(file, violations);
  }
}

const root = process.cwd();
if (violations.length === 0) {
  console.log(`✅ 插件边界检查通过（扫描 ${scanned} 个源文件）`);
  process.exit(0);
}

console.error(`❌ 插件边界检查未通过：${violations.length} 处违规\n`);
for (const v of violations) {
  console.error(`规则 ${v.rule.id}｜${v.rule.name}`);
  console.error(`  ${relative(root, v.file).split(sep).join("/")}:${v.line}`);
  console.error(`  ${v.text}`);
  console.error(`  → ${v.rule.hint}\n`);
}
process.exit(1);
