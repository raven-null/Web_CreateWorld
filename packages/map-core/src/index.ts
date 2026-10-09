/**
 * 地图编辑器内核的出口。
 *
 * 约定：本包（@worldmap/core）是纯逻辑，**零运行时依赖、零平台 API**
 * （不得出现 window / document / fetch / localStorage 等），
 * 因此这里的数据类型与函数可以被网站、桌面端、移动端以及任何宿主共用。
 */
export * from "./types";
export * from "./stats";
export * from "./projection";
export * from "./scale";
export * from "./geo-distance";
export * from "./geo-area";
export * from "./units";
export * from "./feature-visibility";
export * from "./scale-hints";
