/**
 * 主题 token 与 CSS 变量注入（方案 §15.4）。
 *
 * 插件**不假设宿主的 CSS 变量名**：这里定义自己命名空间的一组 token，
 * 宿主可通过 props 覆盖，不传则用内置默认值（与主站深色主题取同值，装进主站像原生）。
 */
import type { MapEditorTheme } from "@worldmap/core";

/** 内置默认主题（深色墨色，对齐主站 styles.css 的 :root 变量） */
export const DEFAULT_THEME: MapEditorTheme = {
  background: "#14120f",
  panel: "#1c1915",
  border: "#3a332a",
  text: "#e8e0d3",
  textDim: "#a89c88",
  textFaint: "#776c5c",
  accent: "#c9a15c",
  radius: "6px",
  fontSans: '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif',
  fontSerif: '"Source Han Serif SC", "Noto Serif SC", "Songti SC", serif',
  globeSkyColor: "#070c14",
  globeAtmosphereColor: "#5b8fa8",
  globeNightColor: "#0a1420",
};

/**
 * 合并用户主题与默认主题。
 * @param theme 用户传入的主题（可部分覆盖）
 * @returns 完整主题
 */
export function resolveTheme(theme?: Partial<MapEditorTheme>): MapEditorTheme {
  return { ...DEFAULT_THEME, ...theme };
}

/**
 * 把主题转换成内联 CSS 变量对象，交给 React 赋在根元素上。
 *
 * 用内联变量而不是全局样式表：既不污染宿主样式，也不需要宿主做任何配置。
 * @param theme 完整主题
 * @returns 可直接展开到 style 的变量对象
 */
export function themeToCssVars(theme: MapEditorTheme): Record<string, string> {
  return {
    "--wme-background": theme.background,
    "--wme-panel": theme.panel,
    "--wme-border": theme.border,
    "--wme-text": theme.text,
    "--wme-text-dim": theme.textDim,
    "--wme-text-faint": theme.textFaint,
    "--wme-accent": theme.accent,
    "--wme-radius": theme.radius,
    "--wme-font-sans": theme.fontSans,
    "--wme-font-serif": theme.fontSerif,
  };
}
