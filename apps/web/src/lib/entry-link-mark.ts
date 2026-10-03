import { Mark, mergeAttributes } from "@tiptap/core";

/** 命令类型扩展：为编辑器链式调用提供 setEntryLink / unsetEntryLink */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    entryLink: {
      /** 把当前选区标记为指向某条目的关联 */
      setEntryLink: (entryId: string) => ReturnType;
      /** 取消选区的条目关联 */
      unsetEntryLink: () => ReturnType;
    };
  }
}

/**
 * 条目关联标记：选中文字关联到另一个条目。
 * 数据上只存目标条目 id（data-entry-id），显示文本即用户选中的文字。
 */
export const EntryLinkMark = Mark.create({
  name: "entryLink",

  // 光标在标记之后输入时不延续标记
  inclusive: false,

  addAttributes() {
    return {
      entryId: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-entry-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-entry-id": HTMLAttributes.entryId,
        class: "entry-link",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setEntryLink:
        (entryId: string) =>
        ({ commands }) =>
          commands.setMark(this.name, { entryId }),
      unsetEntryLink:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
