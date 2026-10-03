/**
 * 统计字数：中日韩字符按单字计，拉丁字母 / 数字按单词计。
 * 近似值，用于条目字数展示。
 * @param text 纯文本
 * @returns 字数
 */
export function countWords(text: string): number {
  const cjkMatches = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
  const latinMatches = text.match(/[a-zA-Z0-9]+/g);
  return (cjkMatches?.length ?? 0) + (latinMatches?.length ?? 0);
}
