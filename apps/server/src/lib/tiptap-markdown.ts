/** TipTap JSON 节点（导出解析用） */
interface TipTapNode {
  type?: string;
  text?: string;
  content?: TipTapNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
}

/** 提取节点内全部纯文本 */
function plainText(node: TipTapNode): string {
  if (typeof node.text === "string") {
    return node.text;
  }
  return (node.content ?? []).map((child) => plainText(child)).join("");
}

/**
 * 渲染行内内容（文本 + 标记）。
 * entryLink 标记转为 [[条目标题]]，便于在 Obsidian 等工具中继续使用双向链接。
 * @param nodes 行内节点
 * @param entryTitleById 条目 id → 标题映射
 * @returns Markdown 行内文本
 */
function renderInline(nodes: TipTapNode[], entryTitleById: Map<string, string>): string {
  return nodes
    .map((node) => {
      if (node.type === "hardBreak") {
        return "\n";
      }
      if (typeof node.text !== "string") {
        return renderInline(node.content ?? [], entryTitleById);
      }

      let text = node.text;
      for (const mark of node.marks ?? []) {
        switch (mark.type) {
          case "bold":
            text = `**${text}**`;
            break;
          case "italic":
            text = `*${text}*`;
            break;
          case "strike":
            text = `~~${text}~~`;
            break;
          case "code":
            text = `\`${text}\``;
            break;
          case "entryLink": {
            const entryId = typeof mark.attrs?.entryId === "string" ? mark.attrs.entryId : "";
            text = `[[${entryTitleById.get(entryId) ?? text}]]`;
            break;
          }
          default:
            break;
        }
      }
      return text;
    })
    .join("");
}

/**
 * 渲染块级节点列表（之间空一行）。
 * @param nodes 块级节点
 * @param entryTitleById 条目 id → 标题映射
 * @returns Markdown 文本
 */
function renderBlocks(nodes: TipTapNode[], entryTitleById: Map<string, string>): string {
  return nodes
    .map((node) => renderBlock(node, entryTitleById))
    .filter((block) => block.trim() !== "")
    .join("\n\n");
}

/** 渲染单个块级节点 */
function renderBlock(node: TipTapNode, entryTitleById: Map<string, string>): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content ?? [], entryTitleById);
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 2, 1), 6);
      return `${"#".repeat(level)} ${renderInline(node.content ?? [], entryTitleById)}`;
    }
    case "bulletList":
      return (node.content ?? [])
        .map((item) => `- ${renderBlocks(item.content ?? [], entryTitleById).replace(/\n/g, " ")}`)
        .join("\n");
    case "orderedList":
      return (node.content ?? [])
        .map((item, index) => `${index + 1}. ${renderBlocks(item.content ?? [], entryTitleById).replace(/\n/g, " ")}`)
        .join("\n");
    case "blockquote":
      return renderBlocks(node.content ?? [], entryTitleById)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "codeBlock":
      return `\`\`\`\n${plainText(node)}\n\`\`\``;
    case "horizontalRule":
      return "---";
    case "hardBreak":
      return "\n";
    default:
      if (typeof node.text === "string") {
        return renderInline([node], entryTitleById);
      }
      return renderBlocks(node.content ?? [], entryTitleById);
  }
}

/**
 * 把 TipTap 文档转换为 Markdown。
 * @param doc TipTap 文档节点
 * @param entryTitleById 条目 id → 标题映射（用于条目关联）
 * @returns Markdown 正文
 */
export function tipTapToMarkdown(doc: TipTapNode, entryTitleById: Map<string, string>): string {
  return renderBlocks(doc.content ?? [], entryTitleById).trim();
}
