import { countWords } from "@create-world/core";

/** TipTap 标记（仅声明用到的字段） */
export interface TipTapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/** TipTap JSON 节点（仅声明用到的字段） */
export interface TipTapNode {
  type?: string;
  text?: string;
  content?: TipTapNode[];
  marks?: TipTapMark[];
  attrs?: Record<string, unknown>;
}

/** TipTap 文档根节点 */
export interface TipTapDoc {
  type: "doc";
  content?: TipTapNode[];
}

/** 正文中的条目关联 */
export interface EntryLink {
  toEntryId: string;
  toTitle: string;
}

/**
 * 递归提取节点中的全部纯文本。
 * @param node TipTap 节点
 * @returns 拼接后的纯文本
 */
export function extractPlainText(node: TipTapNode | undefined): string {
  if (!node) {
    return "";
  }
  if (typeof node.text === "string") {
    return node.text;
  }
  return (node.content ?? []).map((child) => extractPlainText(child)).join("");
}

/**
 * 统计一份 TipTap 文档的字数（近似值）。
 * @param doc TipTap 文档
 * @returns 字数
 */
export function countDocWords(doc: TipTapDoc): number {
  return countWords(extractPlainText(doc));
}

/**
 * 提取正文中的条目关联（entryLink 标记），按目标条目去重。
 * @param doc TipTap 文档
 * @returns 关联列表
 */
export function extractEntryLinks(doc: TipTapDoc): EntryLink[] {
  const links: EntryLink[] = [];
  const seen = new Set<string>();

  /** 深度遍历节点树，收集带 entryLink 标记的文本节点 */
  const visit = (node: TipTapNode) => {
    if (typeof node.text === "string" && node.marks) {
      for (const mark of node.marks) {
        if (mark.type !== "entryLink") {
          continue;
        }
        const entryId = typeof mark.attrs?.entryId === "string" ? mark.attrs.entryId : "";
        if (entryId && !seen.has(entryId)) {
          seen.add(entryId);
          links.push({ toEntryId: entryId, toTitle: node.text.slice(0, 120) });
        }
      }
    }
    for (const child of node.content ?? []) {
      visit(child);
    }
  };

  visit(doc as TipTapNode);
  return links;
}

/**
 * 安全解析内容块 JSON；损坏时返回空文档。
 * @param contentJson 内容块 JSON 字符串
 * @returns TipTap 文档
 */
export function parseDoc(contentJson: string): TipTapDoc {
  try {
    const parsed = JSON.parse(contentJson) as TipTapDoc;
    if (parsed && parsed.type === "doc") {
      return parsed;
    }
  } catch {
    // 解析失败按空文档处理
  }
  return { type: "doc", content: [] };
}
