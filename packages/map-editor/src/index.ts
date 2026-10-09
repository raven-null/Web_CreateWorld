/**
 * 地图编辑器插件本体的出口。
 *
 * 约束（详见 docs/地图编辑器方案.md §15.1，由 scripts/check-boundaries.mjs 强制检查）：
 * - 不 import 主站任何模块（@create-world/*、apps/web 的 src/*）
 * - 不出现宿主业务概念（world / entry / invite 等）
 * - 不直接 fetch 与 window.location：所有数据进出走宿主实现的 MapHostAdapter
 * - 不使用 React Context：所需状态一律从 props 传入（这是将来能补 Web Component 的前提）
 */
export * from "./adapter";
export * from "./props";
