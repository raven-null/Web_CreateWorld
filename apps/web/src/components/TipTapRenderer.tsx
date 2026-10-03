import { Fragment, type ReactNode } from "react";
import { extractPlainText, type TipTapMark, type TipTapNode } from "../lib/tiptap-json";

interface TipTapRendererProps {
  /** 要渲染的 TipTap 文档节点 */
  doc: TipTapNode;
  /** 点击条目关联时的回调（跳转到目标条目） */
  onEntryLinkClick?: (entryId: string) => void;
}

/**
 * 应用单个标记（加粗 / 斜体 / 条目关联等）。
 * @param children 被标记的内容
 * @param mark 标记数据
 * @param onEntryLinkClick 条目关联点击回调
 * @returns 包裹后的 React 节点
 */
function applyMark(
  children: ReactNode,
  mark: TipTapMark,
  onEntryLinkClick?: (entryId: string) => void,
): ReactNode {
  switch (mark.type) {
    case "bold":
      return <strong>{children}</strong>;
    case "italic":
      return <em>{children}</em>;
    case "strike":
      return <s>{children}</s>;
    case "code":
      return <code>{children}</code>;
    case "entryLink": {
      const entryId = typeof mark.attrs?.entryId === "string" ? mark.attrs.entryId : "";
      return (
        <a
          className="entry-link"
          data-entry-id={entryId}
          href={`#entry-${entryId}`}
          onClick={(event) => {
            event.preventDefault();
            if (entryId) {
              onEntryLinkClick?.(entryId);
            }
          }}
        >
          {children}
        </a>
      );
    }
    default:
      return children;
  }
}

/**
 * 渲染文本节点（按标记依次包裹）。
 * @param node 文本节点
 * @param onEntryLinkClick 条目关联点击回调
 * @returns React 节点
 */
function renderTextNode(node: TipTapNode, onEntryLinkClick?: (entryId: string) => void): ReactNode {
  let element: ReactNode = node.text ?? "";
  for (const mark of node.marks ?? []) {
    element = applyMark(element, mark, onEntryLinkClick);
  }
  return element;
}

/**
 * 递归渲染 TipTap 节点（覆盖编辑器用到的节点类型）。
 * @param node 当前节点
 * @param onEntryLinkClick 条目关联点击回调
 * @returns React 节点
 */
function renderNode(node: TipTapNode, onEntryLinkClick?: (entryId: string) => void): ReactNode {
  const children = (node.content ?? []).map((child, index) => (
    <Fragment key={index}>{renderNode(child, onEntryLinkClick)}</Fragment>
  ));

  switch (node.type) {
    case "doc":
      return children;
    case "paragraph":
      return <p>{children}</p>;
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 2, 1), 4);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
      return <Tag>{children}</Tag>;
    }
    case "bulletList":
      return <ul>{children}</ul>;
    case "orderedList":
      return <ol>{children}</ol>;
    case "listItem":
      return <li>{children}</li>;
    case "blockquote":
      return <blockquote>{children}</blockquote>;
    case "codeBlock":
      return (
        <pre>
          <code>{extractPlainText(node)}</code>
        </pre>
      );
    case "horizontalRule":
      return <hr />;
    case "hardBreak":
      return <br />;
    case "text":
      return renderTextNode(node, onEntryLinkClick);
    default:
      return <div>{children}</div>;
  }
}

/**
 * 只读渲染 TipTap JSON（阅读态 / 版本预览）。
 */
export default function TipTapRenderer({ doc, onEntryLinkClick }: TipTapRendererProps) {
  return <div className="rich-text">{renderNode(doc, onEntryLinkClick)}</div>;
}
