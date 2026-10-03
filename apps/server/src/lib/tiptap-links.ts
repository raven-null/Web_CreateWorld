/** TipTap JSON 节点（仅声明解析需要的字段） */
interface TipTapNode {
  type?: string;
  text?: string;
  content?: TipTapNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

/**
 * 从内容块 JSON 中提取条目关联（entryLink 标记），按目标条目去重。
 * 用于回滚等场景在服务端重建 entry_links 表。
 * @param blocks 内容块列表（含 contentJson）
 * @returns 关联列表
 */
export function extractEntryLinksFromBlocks(
  blocks: Array<{ contentJson: string }>,
): Array<{ toEntryId: string; toTitle: string }> {
  const links: Array<{ toEntryId: string; toTitle: string }> = [];
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

  for (const block of blocks) {
    try {
      const doc = JSON.parse(block.contentJson) as TipTapNode;
      visit(doc);
    } catch {
      // 跳过损坏的内容块
    }
  }
  return links;
}
